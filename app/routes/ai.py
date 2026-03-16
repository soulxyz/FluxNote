from flask import Blueprint, request, jsonify, Response, stream_with_context, current_app
from flask_login import login_required
from app.services.ai_service import AIService
from app.utils.error_handler import safe_error
import uuid
import os
import re
import time
import httpx

ai_bp = Blueprint('ai', __name__)

# 内存缓存：{bvid: (data_dict, cached_at_timestamp)}
# 7 天 TTL，重启自动失效，对个人博客完全够用
_bili_cache: dict = {}
_BILI_CACHE_TTL = 7 * 24 * 3600

@ai_bp.route('/ai/stream', methods=['POST'])
@login_required
def stream_ai():
    """Stream AI response"""
    data = request.json
    action = data.get('action')
    content = data.get('content') # If action is present, we expect content instead of prompt
    
    # Legacy/Direct prompt mode
    prompt = data.get('prompt')
    system_prompt = data.get('system_prompt', '你是一位深思熟虑的笔记助手。请帮助我整理思绪，提取关键洞见，保持语言简洁客观。')

    if action:
        if not content:
             return jsonify({'error': 'Content is required for actions'}), 400
        
        # Build prompt on server side
        if action == 'polish':
            from app.models import Config
            styles_str = Config.get('polish_styles', '专业严谨,简洁明了,亲和力强')
            styles = [s.strip() for s in styles_str.split(',') if s.strip()]
            if not styles:
                styles = ['专业严谨', '简洁明了', '亲和力强']
            
            style_instructions = ""
            output_format = ""
            for i, style in enumerate(styles, 1):
                style_instructions += f"{i}. {style}\n"
                output_format += f"### {style}\n(内容)\n"

            prompt = f"""你是一个专业的文本编辑。请将以下文本润色为这{len(styles)}种风格：
{style_instructions}
严格按照以下格式输出润色后的内容，禁止包含任何开场白、解释或多余的空行：

{output_format}
待润色文本:
{content[:2000]}"""
            system_prompt = "你是一个只输出结果、不废话的编辑助手。"
            
        elif action == 'summary':
             prompt = f"用约50-100字总结以下文本。保持简洁客观。只返回总结文本。\n\n文本:\n{content[:3000]}"
             system_prompt = "你是一个精炼的总结助手。"
             
        elif action == 'tags':
             prompt = f"分析以下文本并建议3-5个相关标签。只返回一个字符串的JSON数组，例如 [\"tag1\", \"tag2\"]。不要包含任何解释或Markdown格式。\n\n文本:\n{content[:2000]}"
             system_prompt = "你是一个分类专家。"

        elif action == 'voice_organize':
             prompt = f"""以下是一段语音转文字的原始内容，可能存在口语化表达、重复、语气词、断句不清等问题。
请将其整理为结构清晰的 Markdown 笔记，要求：
1. 去除语气词（嗯、啊、那个等）和重复内容
2. 修正可能的语音识别错误
3. 合理分段，如有多个要点则使用列表
4. 如能提炼出标题则加上标题
5. 保持原意，不要添加原文没有的内容
6. 直接输出整理后的内容，不要加任何解释说明

原始语音内容：
{content[:3000]}"""
             system_prompt = "你是一个专业的笔记整理助手，擅长将口语化的内容转化为结构清晰的书面笔记。"

        elif action == 'document_summary':
             doc_id = data.get('doc_id')
             if not doc_id:
                  return jsonify({'error': 'doc_id is required for document summary'}), 400
             from app.models import Document
             doc = Document.query.filter_by(id=doc_id).first()
             if not doc:
                  return jsonify({'error': 'Document not found'}), 404
             text_content = doc.text_content
             original_filename = doc.original_filename
             if not text_content or len(text_content.strip()) < 50:
                  return jsonify({'error': 'Document content is too short for summary'}), 400
             
             excerpt = text_content[:3000]
             prompt = f'文档名：《{original_filename}》\n\n文档内容（节选）：\n{excerpt}'
             system_prompt = '你是一个文档摘要助手，请用 1-3 句话简洁地概括文档的核心内容，不要使用列表，直接输出摘要文字。'

    if not prompt:
        return jsonify({'error': 'Prompt is required'}), 400

    def generate():
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ]
        full_response = ""
        try:
            for chunk in AIService.chat_completion_stream(messages):
                full_response += chunk
                yield chunk
                
            # Stream complete, update database if it's a document summary
            if action == 'document_summary' and data.get('doc_id') and full_response:
                try:
                    from app.extensions import db
                    from app.models import Document
                    doc = Document.query.get(data.get('doc_id'))
                    if doc:
                        doc.ai_summary = full_response
                        db.session.commit()
                except Exception as db_e:
                    from flask import current_app
                    current_app.logger.error(f"Failed to save AI summary to database: {db_e}")
                    db.session.rollback()
                    
        except Exception as e:
            yield f"Error: {str(e)}"

    return Response(stream_with_context(generate()), mimetype='text/plain')

@ai_bp.route('/ai/transcribe', methods=['POST'])
@login_required
def transcribe_audio():
    """Transcribe uploaded audio file using Whisper-compatible API"""
    if 'audio' not in request.files:
        return jsonify({'error': 'No audio file provided'}), 400

    audio_file = request.files['audio']
    if not audio_file.filename:
        return jsonify({'error': 'Empty audio file'}), 400

    try:
        audio_data = audio_file.read()
        if len(audio_data) < 1000:
            return jsonify({'error': '录音时间太短，请至少录制 1 秒以上'}), 400
        max_size = 25 * 1024 * 1024
        if len(audio_data) > max_size:
            return jsonify({'error': f'音频文件过大（{len(audio_data) // 1024 // 1024}MB），最大支持 25MB'}), 400

        text = AIService.transcribe_audio(audio_data, audio_file.filename)
        text = (text or '').strip()
        if not text:
            return jsonify({'error': '未识别到有效语音内容，请确保录音环境安静并对准麦克风'}), 400
        return jsonify({'text': text})
    except Exception as e:
        error_msg = str(e)
        if '配置' in error_msg or '服务商' in error_msg:
            return jsonify({'error': error_msg, 'type': 'config'}), 400
        return jsonify({'error': error_msg}), 500


@ai_bp.route('/ai/stt/config', methods=['GET'])
@login_required
def get_stt_config():
    """Get STT configuration"""
    config = AIService.get_stt_config()
    if config.get('api_key'):
        config['api_key_masked'] = config['api_key'][:8] + '...' if len(config['api_key']) > 8 else '***'
    return jsonify(config)


@ai_bp.route('/ai/stt/config', methods=['POST'])
@login_required
def save_stt_config():
    """Save STT configuration"""
    data = request.json
    current = AIService.get_stt_config()
    if data.get('api_key') and '...' not in data['api_key']:
        current['api_key'] = data['api_key']
    if 'base_url' in data:
        current['base_url'] = data['base_url']
    if 'model' in data:
        current['model'] = data['model']
    AIService.save_stt_config(current)
    return jsonify({'success': True})


@ai_bp.route('/ai/audio/save', methods=['POST'])
@login_required
def save_audio():
    """Save recorded audio file and return a public URL"""
    if 'audio' not in request.files:
        return jsonify({'error': 'No audio file'}), 400
    audio_file = request.files['audio']
    audio_data = audio_file.read()
    if len(audio_data) < 1000:
        return jsonify({'error': '录音太短'}), 400

    SAFE_AUDIO_EXTS = {'webm', 'ogg', 'mp3', 'wav', 'mp4', 'm4a', 'flac', 'aac', 'opus'}
    ext = audio_file.filename.rsplit('.', 1)[-1].lower() if '.' in (audio_file.filename or '') else 'webm'
    if ext not in SAFE_AUDIO_EXTS:
        return jsonify({'error': f'不支持的音频格式: .{ext}'}), 400
    filename = f"{uuid.uuid4().hex}.{ext}"
    upload_folder = current_app.config['UPLOAD_FOLDER']
    os.makedirs(upload_folder, exist_ok=True)
    with open(os.path.join(upload_folder, filename), 'wb') as f:
        f.write(audio_data)
    return jsonify({'url': f'/uploads/{filename}'})


@ai_bp.route('/bilibili/info', methods=['GET'])
def bilibili_video_info():
    """Proxy bilibili video info with in-memory cache (TTL=7d)"""
    bvid = request.args.get('bvid', '').strip()
    if not bvid or not re.match(r'^BV[a-zA-Z0-9]+$', bvid):
        return jsonify({'error': 'Invalid BV ID'}), 400

    # 命中缓存则直接返回，不请求 B 站
    cached = _bili_cache.get(bvid)
    if cached:
        data, ts = cached
        if time.time() - ts < _BILI_CACHE_TTL:
            return jsonify(data)
        else:
            del _bili_cache[bvid]

    try:
        with httpx.Client(timeout=8, follow_redirects=True) as http:
            resp = http.get(
                f'https://api.bilibili.com/x/web-interface/view?bvid={bvid}',
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.bilibili.com/',
                    'Accept': 'application/json',
                }
            )
        if resp.status_code != 200:
            return jsonify({'error': f'HTTP {resp.status_code}'}), 502
        data = resp.json()
        if data.get('code') != 0:
            return jsonify({'error': data.get('message', '未知错误')}), 400
        v = data['data']
        cover = (v.get('pic') or '').replace('http://', 'https://')
        # 去掉 B 站图床缩略图参数，交给前端 img referrerpolicy 处理防盗链
        # 不加 @xxx 参数，避免部分 CDN 节点对带参数的 URL 拦截
        result = {
            'bvid': bvid,
            'title': v.get('title', ''),
            'cover': cover,
            'owner': v.get('owner', {}).get('name', ''),
            'duration': v.get('duration', 0),
        }
        _bili_cache[bvid] = (result, time.time())
        return jsonify(result)
    except httpx.TimeoutException:
        return jsonify({'error': '请求超时'}), 504
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@ai_bp.route('/ai/providers', methods=['GET'])
@login_required
def get_providers():
    """Get all configured AI providers"""
    return jsonify(AIService.get_providers())

@ai_bp.route('/ai/providers', methods=['POST'])
@login_required
def save_provider():
    """Add or update a provider"""
    data = request.json
    providers = AIService.get_providers()

    # If it's a new provider (no ID), add it
    if not data.get('id'):
        data['id'] = str(uuid.uuid4())
        # If it's the first one, make it active by default
        if not providers:
            data['is_active'] = True
        else:
            data['is_active'] = False
        providers.append(data)
    else:
        # Update existing
        for i, p in enumerate(providers):
            if p['id'] == data['id']:
                providers[i] = {**p, **data} # Merge updates
                break

    AIService.save_providers(providers)
    return jsonify({'success': True, 'providers': providers})

@ai_bp.route('/ai/providers/<provider_id>', methods=['DELETE'])
@login_required
def delete_provider(provider_id):
    """Delete a provider"""
    providers = AIService.get_providers()
    providers = [p for p in providers if p['id'] != provider_id]
    AIService.save_providers(providers)
    return jsonify({'success': True})

@ai_bp.route('/ai/providers/activate', methods=['POST'])
@login_required
def activate_provider():
    """Set the active provider"""
    provider_id = request.json.get('id')
    providers = AIService.get_providers()

    for p in providers:
        p['is_active'] = (p['id'] == provider_id)

    AIService.save_providers(providers)
    return jsonify({'success': True})

@ai_bp.route('/ai/chat', methods=['POST'])
@login_required
def chat():
    """Generic chat endpoint for AI features"""
    data = request.json
    prompt = data.get('prompt')
    system_prompt = data.get('system_prompt', '你是一位深思熟虑的笔记助手。请帮助我整理思绪，提取关键洞见，保持语言简洁客观。')

    if not prompt:
        return jsonify({'error': 'Prompt is required'}), 400

    try:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ]
        response = AIService.chat_completion(messages)
        return jsonify({'response': response})
    except Exception as e:
        return jsonify(safe_error(e, 'AI对话失败')), 500

@ai_bp.route('/ai/tags', methods=['POST'])
@login_required
def generate_tags():
    content = request.json.get('content')
    if not content:
        return jsonify({'error': 'Content is required'}), 400
    try:
        tags = AIService.generate_tags(content)
        return jsonify({'tags': tags})
    except Exception as e:
        return jsonify(safe_error(e, '生成标签失败')), 500

@ai_bp.route('/ai/summary', methods=['POST'])
@login_required
def generate_summary():
    content = request.json.get('content')
    if not content:
        return jsonify({'error': 'Content is required'}), 400
    try:
        summary = AIService.generate_summary(content)
        return jsonify({'summary': summary})
    except Exception as e:
        return jsonify(safe_error(e, '生成摘要失败')), 500

@ai_bp.route('/ai/polish', methods=['POST'])
@login_required
def polish_text():
    content = request.json.get('content')
    if not content:
        return jsonify({'error': 'Content is required'}), 400
    try:
        polished = AIService.polish_text(content)
        return jsonify({'polished': polished})
    except Exception as e:
        return jsonify(safe_error(e, '润色文本失败')), 500

@ai_bp.route('/ai/custom_prompts', methods=['GET'])
@login_required
def get_custom_prompts():
    """Get all custom prompts"""
    return jsonify(AIService.get_custom_prompts())

@ai_bp.route('/ai/custom_prompts', methods=['POST'])
@login_required
def save_custom_prompt():
    """Add or update a custom prompt"""
    data = request.json
    prompts = AIService.get_custom_prompts()

    if not data.get('id'):
        data['id'] = str(uuid.uuid4())
        prompts.append(data)
    else:
        for i, p in enumerate(prompts):
            if p['id'] == data['id']:
                prompts[i] = {**p, **data}
                break

    AIService.save_custom_prompts(prompts)
    return jsonify({'success': True, 'prompts': prompts})

@ai_bp.route('/ai/custom_prompts/<prompt_id>', methods=['DELETE'])
@login_required
def delete_custom_prompt(prompt_id):
    """Delete a custom prompt"""
    prompts = AIService.get_custom_prompts()
    prompts = [p for p in prompts if p['id'] != prompt_id]
    AIService.save_custom_prompts(prompts)
    return jsonify({'success': True})
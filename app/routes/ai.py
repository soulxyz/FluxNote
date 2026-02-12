from flask import Blueprint, request, jsonify, Response, stream_with_context
from flask_login import login_required
from app.services.ai_service import AIService
import uuid

ai_bp = Blueprint('ai', __name__)

@ai_bp.route('/ai/stream', methods=['POST'])
@login_required
def stream_ai():
    """Stream AI response"""
    data = request.json
    prompt = data.get('prompt')
    system_prompt = data.get('system_prompt', '你是一个乐于助人的助手。')

    if not prompt:
        return jsonify({'error': 'Prompt is required'}), 400

    def generate():
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ]
        try:
            for chunk in AIService.chat_completion_stream(messages):
                yield chunk
        except Exception as e:
            yield f"Error: {str(e)}"

    return Response(stream_with_context(generate()), mimetype='text/plain')

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
    system_prompt = data.get('system_prompt', '你是一个乐于助人的助手。')

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
        return jsonify({'error': str(e)}), 500

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
        return jsonify({'error': str(e)}), 500

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
        return jsonify({'error': str(e)}), 500

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
        return jsonify({'error': str(e)}), 500

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

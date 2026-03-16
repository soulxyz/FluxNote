from app.models import Config
import json
import openai
import httpx

class AIService:
    @staticmethod
    def get_providers():
        """Get list of AI providers from config"""
        providers_json = Config.get('ai_providers', '[]')
        try:
            return json.loads(providers_json)
        except:
            return []

    @staticmethod
    def save_providers(providers):
        """Save list of AI providers"""
        Config.set('ai_providers', json.dumps(providers))

    @staticmethod
    def get_active_provider():
        """Get the currently active provider"""
        providers = AIService.get_providers()
        for p in providers:
            if p.get('is_active'):
                return p
        return None

    @staticmethod
    def chat_completion(messages, model=None, timeout=None):
        """
        Call the AI API using the active provider.
        """
        provider = AIService.get_active_provider()
        if not provider:
            raise Exception("No active AI provider configured")

        client = openai.OpenAI(
            api_key=provider['api_key'],
            base_url=provider['base_url'],
            timeout=timeout
        )

        try:
            response = client.chat.completions.create(
                model=model or provider['model'],
                messages=messages,
                temperature=0.7
            )
            return response.choices[0].message.content
        except Exception as e:
            raise Exception(f"AI API Error: {str(e)}")

    @staticmethod
    def chat_completion_stream(messages, model=None):
        """
        Call the AI API using the active provider with streaming.
        Yields chunks of content.
        """
        provider = AIService.get_active_provider()
        if not provider:
            yield "Error: No active AI provider configured"
            return

        client = openai.OpenAI(
            api_key=provider['api_key'],
            base_url=provider['base_url']
        )

        try:
            stream = client.chat.completions.create(
                model=model or provider['model'],
                messages=messages,
                temperature=0.7,
                stream=True
            )
            for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        except Exception as e:
            yield f"Error: {str(e)}"

    @staticmethod
    def generate_tags(content):
        """Generate tags for the given content"""
        prompt = f"""
        分析以下文本并建议3-5个相关标签。
        只返回一个字符串的JSON数组，例如 ["tag1", "tag2"]。
        不要包含任何解释或Markdown格式。

        文本:
        {content[:2000]}
        """
        response = AIService.chat_completion([{"role": "user", "content": prompt}])
        try:
            # Clean up potential markdown code blocks if AI adds them
            cleaned = response.replace('```json', '').replace('```', '').strip()
            return json.loads(cleaned)
        except:
            return []

    @staticmethod
    def generate_summary(content):
        """Generate a concise summary"""
        prompt = f"""
        用约50-100字总结以下文本。
        保持简洁客观。
        只返回总结文本。

        文本:
        {content[:3000]}
        """
        return AIService.chat_completion([{"role": "user", "content": prompt}])

    @staticmethod
    def polish_text(content):
        """Polish and improve the text"""
        # Load styles from config or use default
        styles_str = Config.get('polish_styles', '专业严谨,简洁明了,亲和力强')
        styles = [s.strip() for s in styles_str.split(',') if s.strip()]
        
        # Build style section of prompt
        style_instructions = ""
        output_format = ""
        
        for i, style in enumerate(styles, 1):
            style_instructions += f"{i}. **{style}**\n"
            output_format += f"### {style}\n(内容)\n\n"

        prompt = f"""
        你是专业的文本润色编辑。请对以下文本提供{len(styles)}个不同风格的优化版本：
        {style_instructions}

        请严格按照以下Markdown格式输出，不要包含任何开场白或结束语：

        {output_format}

        文本:
        {content[:2000]}
        """
        return AIService.chat_completion([{"role": "user", "content": prompt}])

    @staticmethod
    def get_stt_config():
        """Get STT (Speech-to-Text) configuration"""
        stt_json = Config.get('stt_config', '{}')
        try:
            return json.loads(stt_json)
        except:
            return {}

    @staticmethod
    def save_stt_config(config):
        """Save STT configuration"""
        Config.set('stt_config', json.dumps(config))

    @staticmethod
    def transcribe_audio(audio_file, filename='audio.webm'):
        """Transcribe audio using dedicated STT config or active AI provider"""
        stt = AIService.get_stt_config()
        base_url = stt.get('base_url', '').strip()
        api_key = stt.get('api_key', '').strip()
        model = stt.get('model', '').strip() or 'FunAudioLLM/SenseVoiceSmall'

        if not base_url or not api_key:
            provider = AIService.get_active_provider()
            if not provider:
                raise Exception("请先在设置中配置语音转写服务，或配置 AI 模型")
            base_url = base_url or provider['base_url']
            api_key = api_key or provider['api_key']

        mime_map = {
            '.webm': 'audio/webm', '.mp4': 'audio/mp4', '.m4a': 'audio/m4a',
            '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
        }
        ext = '.' + filename.rsplit('.', 1)[-1].lower() if '.' in filename else '.webm'
        mime_type = mime_map.get(ext, 'audio/webm')

        try:
            with httpx.Client(timeout=60) as http:
                resp = http.post(
                    f"{base_url.rstrip('/')}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    files={"file": (filename, audio_file, mime_type)},
                    data={"model": model},
                )
            if resp.status_code == 404:
                raise Exception("当前服务商不支持语音转写接口，请在设置内更换。")
            if resp.status_code != 200:
                detail = resp.text[:200]
                raise Exception(f"语音转写失败 (HTTP {resp.status_code}): {detail}")
            result = resp.json()
            return result.get('text', '')
        except httpx.HTTPError as e:
            raise Exception(f"语音转写网络错误: {str(e)}")
        except Exception as e:
            if '语音转写' in str(e) or '服务商' in str(e):
                raise
            raise Exception(f"语音转写失败: {str(e)}")

    @staticmethod
    def get_custom_prompts():
        """Get list of custom prompts from config"""
        prompts_json = Config.get('custom_prompts', '[]')
        try:
            return json.loads(prompts_json)
        except:
            return []

    @staticmethod
    def save_custom_prompts(prompts):
        """Save list of custom prompts"""
        Config.set('custom_prompts', json.dumps(prompts))

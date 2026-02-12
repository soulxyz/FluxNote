from app.models import Config
import json
import openai

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
    def chat_completion(messages, model=None):
        """
        Call the AI API using the active provider.
        """
        provider = AIService.get_active_provider()
        if not provider:
            raise Exception("No active AI provider configured")

        client = openai.OpenAI(
            api_key=provider['api_key'],
            base_url=provider['base_url']
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
        prompt = f"""
        重写以下文本，使其更清晰、简洁、专业。
        修正任何语法或拼写错误。
        保持原意。
        只返回重写后的文本。

        文本:
        {content[:2000]}
        """
        return AIService.chat_completion([{"role": "user", "content": prompt}])

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

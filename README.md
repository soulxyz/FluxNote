<div align="center">
  <h1>FluxNote 流光笔记</h1>
  <p>
    <strong>捕捉灵感 · 连接思维</strong>
  </p>
  <p>
    一款极简、私有化部署的个人知识库，融合了卡片笔记与现代 AI 能力。可以兼顾笔记和博客两个身份。
  </p>
<img width="2560" height="1600" alt="c222630e57d7f8d83915d3e40fe6a798" src="https://github.com/user-attachments/assets/c6ec3eaa-e105-4248-99c4-927bf0624604" />

  <p>
    <a href="#-功能特性">功能特性</a> •
    <a href="#-快速开始">快速开始</a> •
    <a href="#-技术栈">技术栈</a> •
    <a href="#-项目结构">项目结构</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/python-3.9+-blue.svg" alt="Python Version">
    <img src="https://img.shields.io/badge/framework-Flask-green.svg" alt="Flask">
    <img src="https://img.shields.io/badge/database-SQLite-lightgrey.svg" alt="SQLite">
    <img src="https://img.shields.io/badge/license-MIT-orange.svg" alt="License">
  </p>
</div>

---

## 📖 简介

**FluxNote** (流光笔记) 它不像传统笔记软件那样厚重，而是专注于**极速捕捉**与**知识连接**。

> *“笔记不仅仅是存储，而是思维的流淌。”*

## ✨ 功能特性

| 功能模块 | 描述 |
| :--- | :--- |
| ⚡ **零摩擦捕捉** | 极简输入框，支持 Markdown、图片粘贴、快捷标签，让记录像发推特一样简单。 |
| 🔗 **双向链接** | 使用 `[[WikiLinks]]` 语法连接笔记，自动生成反向链接与知识图谱。 |
| 🤖 **AI 深度集成** | 内置流式 AI 接口，支持自动打标、摘要生成、文本润色及自定义 Prompt。 |
| 🔐 **无密码登录** | 原生支持 WebAuthn (Windows Hello, TouchID, FaceID)，安全且便捷。 |
| 📊 **数据可视化** | 提供 GitHub 风格的贡献热力图与全站数据统计，直观展示学习轨迹。 |
| 📜 **版本回溯** | 记录每一次思维的迭代，支持颗粒度极细的历史版本回滚。 |
| 📱 **全端适配** | 响应式设计 (Responsive Design)，在桌面、平板与移动端均有完美体验。 |

## 🚀 快速开始

### 环境要求

- Python 3.9+
- Git

### 安装步骤

1. **克隆项目**
   ```bash
   git clone https://github.com/soulxyz/FluxNote.git
   cd FluxNote
   ```

2. **安装依赖**
   ```bash
   pip install -r requirements.txt
   ```


3. **启动应用**
   ```bash
   # 开发模式
   python run.py

   # 生产模式
   python server.py
   ```

   访问 `http://localhost:5001` 即可开启你的知识之旅。

## 技术栈

FluxNote 坚持 **KISS (Keep It Simple, Stupid)** 原则，保持架构的轻量与可维护性。

- **Backend**: Python (Flask) + SQLAlchemy
- **Database**: SQLite (无需额外部署数据库服务)
- **Frontend**: Vanilla JS (ES6+) + CSS Variables (无繁重构建流程)
- **Security**: WebAuthn + Flask-Login
- **AI**: OpenAI API 标准接口兼容

## 项目结构

```text
FluxNote/
├── app/
│   ├── routes/           # 业务路由 (Auth, Notes, AI, Stats)
│   ├── services/         # 核心服务 (AI Service)
│   ├── models.py         # 数据模型定义
│   ├── static/           # 静态资源 (CSS, JS)
│   └── templates/        # Jinja2 模板
├── data/                 # SQLite 数据库存储
├── uploads/              # 用户上传资源
├── run.py                # 开发启动入口
└── server.py             # 生产启动入口 (Waitress)
```

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
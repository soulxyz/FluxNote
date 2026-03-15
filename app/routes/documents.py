"""文档管理路由：上传 PDF/Word → 文本提取 → AI 摘要 → 关联笔记 → 批注 CRUD"""
from flask import Blueprint, request, jsonify, current_app, send_from_directory
from flask_login import login_required, current_user
from app.extensions import db
from app.models import Document, Note, Annotation
from app.services.ai_service import AIService
from werkzeug.utils import secure_filename
import os
import uuid
import logging

logger = logging.getLogger(__name__)

documents_bp = Blueprint('documents', __name__)

ALLOWED_DOC_EXTENSIONS = {'pdf', 'docx', 'doc'}
MAX_DOC_SIZE = 50 * 1024 * 1024  # 50MB


def _allowed_doc(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_DOC_EXTENSIONS


def _extract_pdf(filepath, trusted_root):
    """用 PyMuPDF 提取 PDF 全文和页数"""
    try:
        safe_filepath = os.path.abspath(filepath)
        if not safe_filepath.startswith(os.path.abspath(trusted_root) + os.sep):
            logger.warning(f"PDF 路径不在受信目录内: {safe_filepath}")
            return None, ''

        import fitz  # PyMuPDF
        doc = fitz.open(safe_filepath)
        pages = doc.page_count
        texts = []
        for page in doc:
            texts.append(page.get_text())
        doc.close()
        return pages, '\n'.join(texts)
    except Exception as e:
        logger.warning(f"PDF 文本提取失败: {e}")
        return None, ''


def _extract_docx(filepath, trusted_root):
    """用 mammoth 提取 Word 文档内容（转为 Markdown 格式）"""
    try:
        safe_filepath = os.path.abspath(filepath)
        if not safe_filepath.startswith(os.path.abspath(trusted_root) + os.sep):
            logger.warning(f"Word 路径不在受信目录内: {safe_filepath}")
            return '', ''

        import mammoth
        # mammoth 自定义样式映射，保留标题层级
        style_map = """
            p[style-name='Heading 1'] => # $
            p[style-name='Heading 2'] => ## $
            p[style-name='Heading 3'] => ### $
            p[style-name='Heading 4'] => #### $
            b => **
            i => _
        """
        with open(safe_filepath, 'rb') as f:
            result = mammoth.convert_to_markdown(f, style_map=style_map)
        md = result.value or ''
        # 纯文本用于 AI 摘要（去掉 Markdown 语法）
        import re
        plain = re.sub(r'[#*_`\[\]()>!]', '', md)
        plain = re.sub(r'\s+', ' ', plain).strip()
        return md, plain
    except Exception as e:
        logger.warning(f"Word 文本提取失败: {e}")
        return '', ''


def _generate_ai_summary(text, filename):
    """调用 AI 生成文档摘要（失败时静默降级）"""
    if not text or len(text.strip()) < 50:
        return None
    try:
        excerpt = text[:3000]
        messages = [
            {
                'role': 'system',
                'content': '你是一个文档摘要助手，请用 1-3 句话简洁地概括文档的核心内容，不要使用列表，直接输出摘要文字。'
            },
            {
                'role': 'user',
                'content': f'文档名：《{filename}》\n\n文档内容（节选）：\n{excerpt}'
            }
        ]
        summary = AIService.chat_completion(messages)
        return summary.strip() if summary else None
    except Exception as e:
        logger.info(f"AI 摘要生成跳过（未配置或失败）: {e}")
        return None


@documents_bp.route('/documents', methods=['GET'])
@login_required
def list_documents():
    """列出当前用户所有文档（支持分页 + 关键词过滤）"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)
    keyword = request.args.get('q', '').strip()

    query = Document.query.filter_by(user_id=current_user.id)
    if keyword:
        query = query.filter(Document.original_filename.ilike(f'%{keyword}%'))
    query = query.order_by(Document.created_at.desc())

    total = query.count()
    docs = query.offset((page - 1) * per_page).limit(per_page).all()

    result = []
    for doc in docs:
        d = doc.to_dict()
        # 附加关联笔记标题
        if doc.note_id:
            note = Note.query.filter_by(id=doc.note_id, is_deleted=False).first()
            d['note_title'] = note.title if note else None
        else:
            d['note_title'] = None
        d['annotation_count'] = len(doc.annotations)
        result.append(d)

    return jsonify({
        'documents': result,
        'total': total,
        'page': page,
        'has_next': (page * per_page) < total,
    })


@documents_bp.route('/documents/upload', methods=['POST'])
@login_required
def upload_document():
    """上传文档并处理：文本提取 + AI 摘要"""
    if 'file' not in request.files:
        return jsonify({'error': '未找到文件'}), 400

    file = request.files['file']
    if not file or not file.filename:
        return jsonify({'error': '文件名为空'}), 400

    if not _allowed_doc(file.filename):
        return jsonify({'error': '不支持的文件格式，请上传 PDF 或 Word 文档'}), 400

    note_id = request.form.get('note_id')

    # 验证 note_id 归属
    if note_id:
        note = Note.query.filter_by(id=note_id, user_id=current_user.id, is_deleted=False).first()
        if not note:
            return jsonify({'error': '笔记不存在'}), 404

    # 文件大小检查
    file.seek(0, 2)
    file_size = file.tell()
    file.seek(0)
    if file_size > MAX_DOC_SIZE:
        return jsonify({'error': f'文件过大，最大支持 {MAX_DOC_SIZE // 1024 // 1024}MB'}), 400

    original_filename = file.filename
    safe_name = secure_filename(file.filename)
    if not safe_name or '.' not in safe_name:
        return jsonify({'error': '无效的文件名'}), 400

    ext = safe_name.rsplit('.', 1)[1].lower()
    if ext not in ALLOWED_DOC_EXTENSIONS:
        return jsonify({'error': '不支持的文件格式'}), 400

    doc_id = str(uuid.uuid4())
    stored_name = f"doc_{doc_id}.{ext}"

    upload_folder = os.path.abspath(current_app.config['UPLOAD_FOLDER'])
    filepath = os.path.abspath(os.path.join(upload_folder, stored_name))

    if not filepath.startswith(upload_folder + os.sep):
        return jsonify({'error': '无效的文件路径'}), 400

    file.save(filepath)

    # 文本提取
    page_count = None
    text_content = ''
    md_content = None

    if ext == 'pdf':
        page_count, text_content = _extract_pdf(filepath, upload_folder)
    elif ext in ('docx', 'doc'):
        md_content, text_content = _extract_docx(filepath, upload_folder)

    # AI 摘要（异步降级：失败不影响上传）
    ai_summary = _generate_ai_summary(text_content, original_filename)

    # 写入数据库
    doc = Document(
        id=doc_id,
        note_id=note_id,
        user_id=current_user.id,
        original_filename=original_filename,
        stored_filename=stored_name,
        file_type=ext,
        page_count=page_count,
        file_size=file_size,
        text_content=text_content[:100000] if text_content else None,  # 限制存储大小
        md_content=md_content,
        ai_summary=ai_summary,
    )
    try:
        db.session.add(doc)
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        logger.error(f"文档记录保存失败: {e}")
        if os.path.exists(filepath):
            try:
                os.remove(filepath)
            except Exception as rm_e:
                logger.error(f"发生异常后，清理上传文档失败: {rm_e}")
        return jsonify({'error': '保存文档信息到数据库时发生异常，文档上传失败'}), 500

    result = doc.to_dict()
    result['ai_summary'] = ai_summary
    return jsonify(result), 201


@documents_bp.route('/documents/<doc_id>', methods=['GET'])
@login_required
def get_document(doc_id):
    """获取文档元数据"""
    doc = Document.query.filter_by(id=doc_id, user_id=current_user.id).first_or_404()
    return jsonify(doc.to_dict())


@documents_bp.route('/documents/<doc_id>', methods=['DELETE'])
@login_required
def delete_document(doc_id):
    """删除文档（同时删除文件）"""
    doc = Document.query.filter_by(id=doc_id, user_id=current_user.id).first_or_404()
    
    # 路径安全验证：规范化并确保在受信任的根目录内
    upload_folder = os.path.abspath(current_app.config['UPLOAD_FOLDER'])
    filepath = os.path.abspath(os.path.join(upload_folder, doc.stored_filename))
    
    # 验证 filepath 仍在 upload_folder 内（防止路径遍历攻击）
    try:
        if os.path.commonpath([upload_folder, filepath]) != upload_folder:
            logger.warning(f"尝试访问不安全的路径: {filepath}")
            db.session.delete(doc)
            db.session.commit()
            return jsonify({'ok': True, 'warning': '文件路径验证失败，仅删除数据库记录'})
    except (ValueError, TypeError):
        logger.warning(f"路径验证失败: {filepath}")
        db.session.delete(doc)
        db.session.commit()
        return jsonify({'ok': True, 'warning': '文件路径验证失败,仅删除数据库记录'})
    
    if os.path.exists(filepath):
        try:
            os.remove(filepath)
        except Exception as e:
            logger.warning(f"删除文件失败: {e}")
    db.session.delete(doc)
    db.session.commit()
    return jsonify({'ok': True})


@documents_bp.route('/documents/<doc_id>/file', methods=['GET'])
@login_required
def get_document_file(doc_id):
    """获取原始文件（PDF 供 PDF.js 加载，Word 供下载）"""
    doc = Document.query.filter_by(id=doc_id, user_id=current_user.id).first_or_404()
    upload_folder = current_app.config['UPLOAD_FOLDER']
    as_attachment = doc.file_type in ('docx', 'doc')
    return send_from_directory(
        upload_folder,
        doc.stored_filename,
        as_attachment=as_attachment,
        download_name=doc.original_filename if as_attachment else None
    )


@documents_bp.route('/documents/<doc_id>/md', methods=['GET'])
@login_required
def get_document_md(doc_id):
    """获取 Word 转换的 Markdown 内容"""
    doc = Document.query.filter_by(id=doc_id, user_id=current_user.id).first_or_404()
    if doc.file_type not in ('docx', 'doc') or not doc.md_content:
        return jsonify({'error': '该文档无 Markdown 内容'}), 404
    return jsonify({'md': doc.md_content, 'filename': doc.original_filename})


@documents_bp.route('/notes/<note_id>/documents', methods=['GET'])
@login_required
def get_note_documents(note_id):
    """获取笔记关联的所有文档"""
    note = Note.query.filter_by(id=note_id, user_id=current_user.id, is_deleted=False).first_or_404()
    docs = Document.query.filter_by(note_id=note.id, user_id=current_user.id).order_by(Document.created_at.desc()).all()
    return jsonify([d.to_dict() for d in docs])


@documents_bp.route('/documents/<doc_id>/link', methods=['POST'])
@login_required
def link_document_to_note(doc_id):
    """将文档关联到笔记"""
    doc = Document.query.filter_by(id=doc_id, user_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    note_id = data.get('note_id')
    if not note_id:
        return jsonify({'error': '缺少 note_id'}), 400
    note = Note.query.filter_by(id=note_id, user_id=current_user.id, is_deleted=False).first_or_404()
    doc.note_id = note.id
    db.session.commit()
    return jsonify(doc.to_dict())


# ─── 批注 CRUD ────────────────────────────────────────────────────────────────

@documents_bp.route('/documents/<doc_id>/annotations', methods=['GET'])
@login_required
def get_annotations(doc_id):
    """获取文档的批注列表（可按页码过滤）"""
    doc = Document.query.filter_by(id=doc_id, user_id=current_user.id).first_or_404()
    page_num = request.args.get('page', type=int)  # None = 全部
    query = Annotation.query.filter_by(document_id=doc.id, user_id=current_user.id)
    if page_num is not None:
        query = query.filter_by(page=page_num)
    annotations = query.order_by(Annotation.created_at.asc()).all()
    return jsonify([a.to_dict() for a in annotations])


@documents_bp.route('/documents/<doc_id>/annotations', methods=['POST'])
@login_required
def create_annotation(doc_id):
    """新建批注（高亮 / 标注）"""
    doc = Document.query.filter_by(id=doc_id, user_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    selected_text = (data.get('selected_text') or '').strip()
    if not selected_text:
        return jsonify({'error': '缺少选中文字'}), 400
    color = data.get('color', 'yellow')
    if color not in ('yellow', 'green', 'pink', 'blue'):
        color = 'yellow'

    raw_page = data.get('page')
    if raw_page is not None:
        try:
            page_num = int(raw_page)
            if page_num < 1 or page_num > 10000:
                raise ValueError("页码范围不合法")
            data['page'] = page_num
        except (ValueError, TypeError):
            return jsonify({'error': '无效的页码值'}), 400
    
    # 验证 note_id：如果用户提供了 note_id，必须验证其有效性和归属
    note_id = data.get('note_id')
    if note_id:
        note = Note.query.filter_by(id=note_id, user_id=current_user.id, is_deleted=False).first()
        if not note:
            return jsonify({'error': '笔记不存在或无权访问'}), 404
    else:
        # 如果用户未提供 note_id，使用文档自身的 note_id
        note_id = doc.note_id
    
    ann = Annotation(
        document_id=doc.id,
        user_id=current_user.id,
        note_id=note_id,
        page=data.get('page'),
        selected_text=selected_text[:2000],
        color=color,
        ann_note=(data.get('ann_note') or '').strip() or None,
    )
    db.session.add(ann)
    db.session.commit()
    return jsonify(ann.to_dict()), 201


@documents_bp.route('/annotations/<ann_id>', methods=['PATCH'])
@login_required
def update_annotation(ann_id):
    """更新批注的边注文字或颜色"""
    ann = Annotation.query.filter_by(id=ann_id, user_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    if 'ann_note' in data:
        ann.ann_note = (data['ann_note'] or '').strip() or None
    if 'color' in data and data['color'] in ('yellow', 'green', 'pink', 'blue'):
        ann.color = data['color']
    db.session.commit()
    return jsonify(ann.to_dict())


@documents_bp.route('/annotations/<ann_id>', methods=['DELETE'])
@login_required
def delete_annotation(ann_id):
    """删除批注"""
    ann = Annotation.query.filter_by(id=ann_id, user_id=current_user.id).first_or_404()
    db.session.delete(ann)
    db.session.commit()
    return jsonify({'ok': True})

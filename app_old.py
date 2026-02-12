
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from datetime import datetime
import os
import json
import uuid

app = Flask(__name__)
CORS(app)

# 确保数据目录存在
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(DATA_DIR, exist_ok=True)

NOTES_FILE = os.path.join(DATA_DIR, 'notes.json')

def load_notes():
    """加载笔记数据"""
    if os.path.exists(NOTES_FILE):
        with open(NOTES_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_notes(notes):
    """保存笔记数据"""
    with open(NOTES_FILE, 'w', encoding='utf-8') as f:
        json.dump(notes, f, ensure_ascii=False, indent=2)

@app.route('/')
def index():
    """主页"""
    return render_template('index.html')

@app.route('/api/notes', methods=['GET'])
def get_notes():
    """获取所有笔记"""
    notes = load_notes()
    # 按创建时间倒序排列
    notes.sort(key=lambda x: x.get('created_at', ''), reverse=True)
    return jsonify(notes)

@app.route('/api/notes', methods=['POST'])
def create_note():
    """创建新笔记"""
    data = request.json
    content = data.get('content', '').strip()
    tags = data.get('tags', [])

    if not content:
        return jsonify({'error': '内容不能为空'}), 400

    notes = load_notes()
    new_note = {
        'id': str(uuid.uuid4()),
        'content': content,
        'tags': tags,
        'created_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'updated_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }

    notes.append(new_note)
    save_notes(notes)

    return jsonify(new_note), 201

@app.route('/api/notes/<note_id>', methods=['PUT'])
def update_note(note_id):
    """更新笔记"""
    data = request.json
    content = data.get('content', '').strip()
    tags = data.get('tags', [])

    if not content:
        return jsonify({'error': '内容不能为空'}), 400

    notes = load_notes()
    note_found = False

    for note in notes:
        if note['id'] == note_id:
            note['content'] = content
            note['tags'] = tags
            note['updated_at'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            note_found = True
            break

    if not note_found:
        return jsonify({'error': '笔记不存在'}), 404

    save_notes(notes)
    return jsonify({'success': True})

@app.route('/api/notes/<note_id>', methods=['DELETE'])
def delete_note(note_id):
    """删除笔记"""
    notes = load_notes()
    notes = [note for note in notes if note['id'] != note_id]
    save_notes(notes)
    return jsonify({'success': True})

@app.route('/api/notes/search', methods=['GET'])
def search_notes():
    """搜索笔记"""
    keyword = request.args.get('keyword', '').strip()
    tag = request.args.get('tag', '').strip()

    if not keyword and not tag:
        return jsonify([])

    notes = load_notes()
    results = []

    for note in notes:
        # 关键词搜索
        if keyword and keyword.lower() in note['content'].lower():
            results.append(note)
        # 标签搜索
        elif tag and tag.lower() in [t.lower() for t in note.get('tags', [])]:
            results.append(note)

    # 按创建时间倒序排列
    results.sort(key=lambda x: x.get('created_at', ''), reverse=True)
    return jsonify(results)

@app.route('/api/tags', methods=['GET'])
def get_tags():
    """获取所有标签"""
    notes = load_notes()
    tags = set()

    for note in notes:
        for tag in note.get('tags', []):
            tags.add(tag)

    return jsonify(sorted(list(tags)))

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)

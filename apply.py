import os
import re
css_path = r'D:/Project/轻笔记博客/static/css/style.css'
js_path = r'D:/Project/轻笔记博客/static/js/app.js'
css_content = r'''
.wiki-link { color: var(--primary-color); text-decoration: none; border-bottom: 1px dashed var(--primary-color); transition: all 0.2s ease; cursor: pointer; }
.wiki-link:hover { background-color: rgba(74, 144, 226, 0.1); border-bottom-style: solid; }
.backlinks-section { margin-top: 15px; padding-top: 15px; border-top: 1px solid var(--border-color); font-size: 0.9rem; display: none; }
.backlinks-section.has-backlinks { display: block; }
.backlinks-title { font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px; }
.backlink-item { display: block; padding: 4px 0; color: var(--text-main); text-decoration: none; transition: color 0.2s; }
.backlink-item:hover { color: var(--primary-color); text-decoration: underline; }
.autocomplete-dropdown { position: absolute; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; box-shadow: var(--shadow-hover); max-height: 200px; overflow-y: auto; z-index: 1000; min-width: 200px; display: none; }
.autocomplete-item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid var(--border-color); font-size: 0.9rem; color: var(--text-main); }
.autocomplete-item:last-child { border-bottom: none; }
.autocomplete-item:hover, .autocomplete-item.active { background-color: var(--bg-color); color: var(--primary-color); }
'''
with open(css_path, 'a', encoding='utf-8') as f: f.write(css_content)
print('Updated CSS')

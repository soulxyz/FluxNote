# 流光笔记主题开发指南

## 目录结构

```
themes/
├── spa/          # 行云主题（默认前台主题）
├── anheyu/       # 安然主题
├── next/         # Next主题
├── default/      # 默认主题
└── README.md     # 本文档
```

---

## SPA Loader

前台博客页面启用了 **SPA（单页应用）模式**，页面切换时不会刷新整个页面，而是通过 JavaScript 动态替换内容区域。

### 配置选项

```javascript
spaLoader.setConfig({
    contentSelector: '.main-stream',  // 主内容容器选择器
    navSelector: '.sidebar-nav .nav-item',  // 导航项选择器
    activeClass: 'active'  // 导航激活类名
});
```

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contentSelector` | `string` | `['.main-stream', '.blog-main', '.next-main']` | 主内容容器选择器 |
| `navSelector` | `string` | 多个默认值 | 导航项选择器 |
| `activeClass` | `string` | `'active'` | 导航激活状态的 CSS 类名 |

### 公共方法

#### `navigate(url)`

通过 SPA 方式导航到指定 URL。

```javascript
spaLoader.navigate('/blog?search=关键词');
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | `string` | 目标 URL |

---

#### `loadPage(url, pushState)`

加载页面内容并应用。

```javascript
spaLoader.loadPage('/blog/archive', true);
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `string` | - | 目标 URL |
| `pushState` | `boolean` | `true` | 是否添加到浏览器历史 |

---

#### `setConfig(options)`

配置 SPA Loader 选择器。

```javascript
spaLoader.setConfig({
    contentSelector: '.my-content',
    navSelector: '.my-nav .nav-item',
    activeClass: 'current'
});
```

---

#### `clearCache()`

清除页面缓存。

```javascript
spaLoader.clearCache();
```

---

#### `isInternalLink(href)`

判断链接是否为内部链接。

```javascript
spaLoader.isInternalLink('/blog');  // true
spaLoader.isInternalLink('https://example.com');  // false
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `href` | `string` | 链接地址 |

**返回值**: `boolean`

---

### 内部属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `isLoading` | `boolean` | 是否正在加载 |
| `cacheEnabled` | `boolean` | 是否启用缓存（默认 true） |
| `cacheTTL` | `number` | 缓存有效期（默认 30000ms） |
| `selectors` | `object` | 选择器配置 |
| `progressBar` | `Element` | 进度条元素 |

---

## Theme SDK

主题 SDK 提供统一的能力层，包括 SPA 导航、认证、搜索绑定等。

### 初始化

```javascript
import themeSDK from '/static/js/theme-sdk.js';

themeSDK.init({
    contentSelector: '.main-stream',
    navSelector: '.sidebar-nav .nav-item',
    activeClass: 'active',
    autoResetSelectors: ['#sidebar'],
    resetClasses: ['open', 'mobile-open'],
    auth: true,
    spa: true,
    plugins: {
        mermaid: { theme: 'default' },
        highlight: {}
    }
});
```

### 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `contentSelector` | `string` | `'.blog-main'` | 主内容容器选择器 |
| `navSelector` | `string` | `null` | 导航项选择器 |
| `activeClass` | `string` | `'active'` | 导航激活类名 |
| `autoResetSelectors` | `string[]` | `[]` | 页面切换时重置的选择器 |
| `resetClasses` | `string[]` | `['open', 'active', ...]` | 重置时移除的类名 |
| `auth` | `boolean` | `true` | 是否启用认证 |
| `spa` | `boolean` | `true` | 是否启用 SPA |
| `plugins` | `object` | `{}` | 插件配置 |

---

### 公共方法

#### `init(options)`

初始化主题 SDK。

```javascript
themeSDK.init({
    contentSelector: '.main-stream',
    navSelector: '.sidebar-nav .nav-item'
});
```

---

#### `navigate(url)`

通过 SPA 方式导航（如果 SPA 启用）。

```javascript
themeSDK.navigate('/blog/archive');
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | `string` | 目标 URL |

---

#### `bindSearch(selector, baseUrl)`

绑定搜索框回车事件。

```javascript
themeSDK.bindSearch('#searchInput', '/blog');
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `selector` | `string` | `'#searchInput'` | 搜索框选择器 |
| `baseUrl` | `string` | `'/'` | 跳转基础路径 |

---

#### `bindTagClicks(selector, baseUrl)`

绑定标签点击事件。

```javascript
themeSDK.bindTagClicks('.note-tag[data-tag]', '/tags/');
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `selector` | `string` | `'.note-tag[data-tag]'` | 标签选择器（需有 data-tag 属性） |
| `baseUrl` | `string` | `'/tags/'` | 跳转基础路径 |

---

#### `smartLogin()`

触发智能登录（优先尝试 WebAuthn 生物识别）。

```javascript
themeSDK.smartLogin();
```

---

#### `logout()`

退出登录。

```javascript
themeSDK.logout();
```

---

#### `toggleMobileSidebar()`

切换移动端侧边栏状态。

```javascript
themeSDK.toggleMobileSidebar();
```

---

#### `closeMobileSidebar()`

关闭移动端侧边栏。

```javascript
themeSDK.closeMobileSidebar();
```

---

## 声明式属性

通过 `data-*` 属性实现功能，无需手写 JavaScript。

### `data-spa-ignore`

**用途**：阻止 SPA 拦截，使用正常的页面跳转。

**何时使用**：
- 跳转到**后台管理页面**
- 跳转到**登录/注册页面**
- 需要完整页面刷新的场景

```html
<!-- 正确：跳转后台时忽略 SPA -->
<a href="/" data-spa-ignore>博客管理</a>

<!-- 错误：会被 SPA 拦截，导致页面内容不刷新 -->
<a href="/">博客管理</a>
```

---

### `data-auth-action`

**用途**：声明式认证操作。

**可选值**：
- `login`：触发登录弹窗
- `logout`：退出登录

```html
<a href="#" data-auth-action="login">登录</a>
<a href="#" data-auth-action="logout">退出</a>
```

---

### `data-toggle-menu`

**用途**：声明式菜单/类切换。

```html
<button data-toggle-menu data-target="#sidebar" data-class="collapsed">
    切换侧边栏
</button>

<button data-toggle-menu data-target="body" data-class="menu-open">
    切换菜单
</button>
```

| 属性 | 说明 |
|------|------|
| `data-target` | 目标元素选择器（`body` 表示 body 元素） |
| `data-class` | 要切换的 CSS 类名（默认 `open`） |

---

## 自定义事件

SPA 和 SDK 会触发自定义事件，可用于扩展功能。

### `spa-loaded`

SPA 页面加载完成后触发。

```javascript
window.addEventListener('spa-loaded', (e) => {
    console.log('新页面 URL:', e.detail.url);
    console.log('新页面标题:', e.detail.title);

    // 重新初始化自定义组件
    initMyComponents();
});
```

**事件详情**：
| 属性 | 类型 | 说明 |
|------|------|------|
| `url` | `string` | 新页面 URL |
| `title` | `string` | 新页面标题 |

---

### `page-ready`

页面准备就绪时触发（首屏和 SPA 切换后都会触发）。

```javascript
window.addEventListener('page-ready', () => {
    console.log('页面已准备就绪');
});
```

---

### `theme-ready`

主题初始化完成时触发。

```javascript
window.addEventListener('theme-ready', () => {
    console.log('主题已就绪');
});
```

---

## 自动忽略的链接

以下链接**自动**不会被 SPA 拦截：

| 类型 | 示例 |
|------|------|
| 外部链接 | `https://example.com` |
| 锚点链接 | `#section` |
| JavaScript 链接 | `javascript:void(0)` |
| 邮箱链接 | `mailto:test@example.com` |
| 电话链接 | `tel:+1234567890` |
| 新窗口打开 | `target="_blank"` |
| 带 `data-spa-ignore` | `data-spa-ignore` |
| Ctrl/Cmd + 点击 | 用户主动新窗口打开 |
| Shift + 点击 | 用户主动新窗口打开 |

---

## 模板配置

主题 `base.html` 需要通过 block 配置选择器：

```html
{% extends "base.html" %}

{% block body_class %}theme-mytheme{% endblock %}
{% block content_selector %}.my-main{% endblock %}
{% block nav_selector %}.my-nav .nav-item{% endblock %}
{% block auto_reset_selectors %}['#sidebar']{% endblock %}

{% block body %}
    <aside id="sidebar">...</aside>
    <main class="my-main">
        {% block content %}{% endblock %}
    </main>
{% endblock %}
```

### Block 说明

| Block | 说明 |
|-------|------|
| `body_class` | body 元素的 CSS 类 |
| `content_selector` | 主内容容器选择器（SPA 替换区域） |
| `nav_selector` | 导航项选择器（更新激活状态） |
| `auto_reset_selectors` | 页面切换时重置的选择器数组 |

---

## 用户状态判断

前台主题需要根据用户登录状态显示不同内容：

```html
{% if current_user.is_authenticated %}
    <!-- 已登录：显示管理入口 -->
    <a href="/" data-spa-ignore>博客管理</a>
    <a href="#" data-auth-action="logout">退出</a>
{% else %}
    <!-- 未登录：显示登录入口 -->
    <a href="#" data-auth-action="login">博主登录</a>
{% endif %}
```

**注意**：`current_user` 由 Flask-Login 自动注入模板上下文。

---

## 常见问题

### Q: 页面跳转后内容没有刷新？

**原因**：链接被 SPA 拦截，但目标页面的内容选择器不匹配。

**解决**：
1. 如果是跳转到完全不同的应用（如后台），添加 `data-spa-ignore`
2. 确保目标页面有正确的内容容器

### Q: 页面跳转后 JavaScript 不执行？

**原因**：SPA 只执行主内容区域内的脚本和 `{% block scripts %}` 中的脚本。

**解决**：
- 内联脚本放在内容区域内
- 或者放在 `{% block scripts %}` 中

### Q: 样式丢失？

**原因**：SPA 不会重新加载 CSS。

**解决**：确保所有页面共用同一套样式表（通过 `base.html`）。

### Q: 进度条不显示？

**原因**：缺少进度条 HTML 元素。

**解决**：确保 `base.html` 包含：
```html
<div id="nprogress"><div class="nprogress-bar"></div></div>
```

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `app/static/js/spa-loader.js` | SPA 核心逻辑 |
| `app/static/js/theme-sdk.js` | 主题 SDK（初始化、声明式事件绑定） |
| `app/static/js/auth-module.js` | 认证模块 |
| `app/static/js/markdown-renderer.js` | Markdown 渲染器 |
| `app/templates/base.html` | 全局基础模板 |

---

## 最佳实践

1. **后台链接必须加 `data-spa-ignore`**
   ```html
   <a href="/" data-spa-ignore>进入后台</a>
   ```

2. **认证操作使用声明式属性**
   ```html
   <a href="#" data-auth-action="login">登录</a>
   ```

3. **监听 `spa-loaded` 事件重新初始化组件**
   ```javascript
   window.addEventListener('spa-loaded', () => {
       // 重新初始化自定义组件
   });
   ```

4. **使用 `themeSDK.navigate()` 而非直接修改 `location.href`**
   ```javascript
   // 推荐
   themeSDK.navigate('/blog/archive');

   // 不推荐（绕过 SPA）
   window.location.href = '/blog/archive';
   ```

---

最后更新：2025年2月

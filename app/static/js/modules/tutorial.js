
/**
 * 新手教程模块
 * 提供全屏暗下并高亮特定元素的功能，引导用户了解应用功能
 */

// 教程步骤定义
const tutorialSteps = {
    // 主页教程
    home: [
        {
            element: '#sidebar',
            title: '侧边栏导航',
            content: '这里是侧边栏，包含导航菜单、统计信息和标签列表。点击不同菜单可以切换不同视图，如全部内容、知识图谱、每日回顾等。',
            position: 'right'
        },
        {
            element: '#statsSection',
            title: '统计信息',
            content: '这里显示你的笔记统计信息，包括笔记总数、标签数量和活跃天数。下方的热力图展示了你的写作活跃度。',
            position: 'right'
        },
        {
            element: '#searchInput',
            title: '搜索功能',
            content: '在此输入关键词可以搜索你的笔记内容，支持全文检索。快速找到你需要的笔记。',
            position: 'bottom'
        },
        {
            element: '#noteContent',
            title: '笔记输入区',
            content: '在这里输入你的想法，支持Markdown格式。点击标签按钮可以添加标签，点击右侧发送按钮可以发布笔记。',
            position: 'top'
        },
        {
            element: '#navGraph',
            title: '知识图谱',
            content: '点击这里可以查看笔记之间的关联关系，帮助你发现知识之间的联系，构建你的知识网络。',
            position: 'right'
        },
        {
            element: '#navDailyReview',
            title: '每日回顾',
            content: '查看历史上的今天你写下的笔记，重温过去的思考，发现新的灵感。',
            position: 'right'
        },
        {
            element: '#navShares',
            title: '我的分享',
            content: '查看和管理你分享出去的笔记，可以设置访问密码和有效期。',
            position: 'right'
        }
    ],

    // 设置页面教程
    settings: [
        {
            element: '.settings-sidebar',
            title: '设置导航',
            content: '左侧是设置导航，点击不同选项可以切换到对应的设置页面，包括个人信息、外观设置、功能设置等。',
            position: 'right'
        },
        {
            element: '.settings-content',
            title: '设置内容',
            content: '这里是具体设置项的内容区域，根据左侧导航显示不同的设置选项。修改后记得点击保存按钮。',
            position: 'left'
        }
    ],

    // 分享页面教程
    share: [
        {
            element: '.share-card',
            title: '分享卡片',
            content: '这是你的笔记分享卡片预览，展示了笔记的基本信息。你可以下载这个卡片，分享到社交媒体。',
            position: 'top'
        },
        {
            element: '#shareUrl',
            title: '分享链接',
            content: '复制这个链接，分享给其他人即可查看你的笔记。你可以设置密码和有效期来保护你的分享。',
            position: 'top'
        }
    ]
};

class Tutorial {
    constructor() {
        this.overlay = null;
        this.highlight = null;
        this.tooltip = null;
        this.currentSteps = [];
        this.currentStepIndex = 0;
        this.currentTutorial = null;
        this.isRunning = false;

        this.init();
    }

    init() {
        // 创建教程所需的DOM元素
        this.createTutorialElements();

        // 检查本地存储中是否有已完成的教程记录
        this.checkCompletedTutorials();
    }

    createTutorialElements() {
        // 创建遮罩层
        this.overlay = document.createElement('div');
        this.overlay.className = 'tutorial-overlay';
        document.body.appendChild(this.overlay);

        // 创建高亮元素
        this.highlight = document.createElement('div');
        this.highlight.className = 'tutorial-highlight';
        document.body.appendChild(this.highlight);

        // 创建提示框
        this.tooltip = document.createElement('div');
        this.tooltip.className = 'tutorial-tooltip';
        this.tooltip.innerHTML = `
            <div class="tutorial-title"><i class="fas fa-lightbulb"></i> <span></span></div>
            <div class="tutorial-content"></div>
            <div class="tutorial-actions">
                <div class="tutorial-step-indicator"></div>
                <div class="tutorial-buttons">
                    <button class="tutorial-btn tutorial-btn-skip">跳过教程</button>
                    <button class="tutorial-btn tutorial-btn-prev" style="display:none;">上一步</button>
                    <button class="tutorial-btn tutorial-btn-next">下一步</button>
                </div>
            </div>
        `;
        document.body.appendChild(this.tooltip);

        // 绑定按钮事件
        this.tooltip.querySelector('.tutorial-btn-skip').addEventListener('click', () => this.endTutorial());
        this.tooltip.querySelector('.tutorial-btn-next').addEventListener('click', () => this.nextStep());
        this.tooltip.querySelector('.tutorial-btn-prev').addEventListener('click', () => this.prevStep());

        // 监听窗口大小变化，重新定位高亮元素
        window.addEventListener('resize', () => {
            if (this.isRunning) {
                this.highlightElement(this.currentSteps[this.currentStepIndex]);
            }
        });
    }

    checkCompletedTutorials() {
        const completedTutorials = JSON.parse(localStorage.getItem('completedTutorials') || '[]');
        this.completedTutorials = completedTutorials;
    }

    markTutorialAsCompleted(tutorialId) {
        if (!this.completedTutorials.includes(tutorialId)) {
            this.completedTutorials.push(tutorialId);
            localStorage.setItem('completedTutorials', JSON.stringify(this.completedTutorials));
        }
    }

    isTutorialCompleted(tutorialId) {
        return this.completedTutorials.includes(tutorialId);
    }

    startTutorial(tutorialId, force = false) {
        // 如果教程已完成且不是强制启动，则不执行
        if (!force && this.isTutorialCompleted(tutorialId)) {
            return;
        }

        // 检查教程是否存在
        if (!tutorialSteps[tutorialId]) {
            console.warn(`Tutorial ${tutorialId} not found`);
            return;
        }

        this.currentTutorial = tutorialId;
        this.currentSteps = tutorialSteps[tutorialId];
        this.currentStepIndex = 0;
        this.isRunning = true;

        // 显示遮罩层和高亮元素
        this.overlay.classList.add('active');
        this.highlight.classList.add('active');

        // 显示第一步
        this.showStep(0);
    }

    showStep(index) {
        if (index < 0 || index >= this.currentSteps.length) {
            return;
        }

        const step = this.currentSteps[index];
        this.currentStepIndex = index;

        // 高亮目标元素
        this.highlightElement(step);

        // 更新提示框内容
        this.updateTooltip(step, index);
    }

    highlightElement(step) {
        const element = document.querySelector(step.element);

        if (!element) {
            console.warn(`Element ${step.element} not found`);
            return;
        }

        const rect = element.getBoundingClientRect();

        // 设置高亮区域的位置和大小
        this.highlight.style.width = `${rect.width + 20}px`;
        this.highlight.style.height = `${rect.height + 20}px`;
        this.highlight.style.top = `${rect.top - 10}px`;
        this.highlight.style.left = `${rect.left - 10}px`;

        // 定位提示框
        this.positionTooltip(rect, step.position);
    }

    positionTooltip(elementRect, position) {
        const tooltipRect = this.tooltip.getBoundingClientRect();
        const padding = 20;
        let top, left;

        // 移除所有位置类
        this.tooltip.classList.remove('position-top', 'position-bottom', 'position-left', 'position-right');

        // 根据位置设置提示框
        switch (position) {
            case 'top':
                top = elementRect.top - tooltipRect.height - padding;
                left = elementRect.left + (elementRect.width - tooltipRect.width) / 2;
                this.tooltip.classList.add('position-top');
                break;
            case 'bottom':
                top = elementRect.bottom + padding;
                left = elementRect.left + (elementRect.width - tooltipRect.width) / 2;
                this.tooltip.classList.add('position-bottom');
                break;
            case 'left':
                top = elementRect.top + (elementRect.height - tooltipRect.height) / 2;
                left = elementRect.left - tooltipRect.width - padding;
                this.tooltip.classList.add('position-left');
                break;
            case 'right':
            default:
                top = elementRect.top + (elementRect.height - tooltipRect.height) / 2;
                left = elementRect.right + padding;
                this.tooltip.classList.add('position-right');
                break;
        }

        // 确保提示框在视口内
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (left < padding) {
            left = padding;
        } else if (left + tooltipRect.width > viewportWidth - padding) {
            left = viewportWidth - tooltipRect.width - padding;
        }

        if (top < padding) {
            top = padding;
        } else if (top + tooltipRect.height > viewportHeight - padding) {
            top = viewportHeight - tooltipRect.height - padding;
        }

        this.tooltip.style.top = `${top}px`;
        this.tooltip.style.left = `${left}px`;

        // 显示提示框
        this.tooltip.classList.add('active');
    }

    updateTooltip(step, index) {
        // 更新标题
        this.tooltip.querySelector('.tutorial-title span').textContent = step.title;

        // 更新内容
        this.tooltip.querySelector('.tutorial-content').textContent = step.content;

        // 更新步骤指示器
        this.tooltip.querySelector('.tutorial-step-indicator').textContent = 
            `${index + 1} / ${this.currentSteps.length}`;

        // 更新按钮状态
        const prevBtn = this.tooltip.querySelector('.tutorial-btn-prev');
        const nextBtn = this.tooltip.querySelector('.tutorial-btn-next');

        if (index === 0) {
            prevBtn.style.display = 'none';
        } else {
            prevBtn.style.display = 'inline-block';
        }

        if (index === this.currentSteps.length - 1) {
            nextBtn.textContent = '完成';
        } else {
            nextBtn.textContent = '下一步';
        }
    }

    nextStep() {
        if (this.currentStepIndex < this.currentSteps.length - 1) {
            this.showStep(this.currentStepIndex + 1);
        } else {
            this.endTutorial();
        }
    }

    prevStep() {
        if (this.currentStepIndex > 0) {
            this.showStep(this.currentStepIndex - 1);
        }
    }

    endTutorial() {
        // 标记教程已完成
        this.markTutorialAsCompleted(this.currentTutorial);

        // 隐藏所有元素
        this.overlay.classList.remove('active');
        this.highlight.classList.remove('active');
        this.tooltip.classList.remove('active');

        this.isRunning = false;
        this.currentTutorial = null;
        this.currentSteps = [];
        this.currentStepIndex = 0;
    }
}

// 创建单例实例
const tutorial = new Tutorial();

// 导出教程实例
export { tutorial };

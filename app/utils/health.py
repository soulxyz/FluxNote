import logging
from pathlib import Path

from werkzeug.exceptions import MethodNotAllowed, NotFound
from werkzeug.routing import RequestRedirect
from sqlalchemy import inspect, text

from app.extensions import db

logger = logging.getLogger(__name__)

def run_self_check(app):
    """一站式自愈与诊断"""
    with app.app_context():
        # 1. 自动检查并同步数据库结构
        try:
            sync_database_schema(app)
        except Exception:
            logger.exception("数据库自检出错")

        # 2. 扫描潜在的路由冲突 (仅打印警告)
        try:
            check_route_shadowing(app)
        except Exception as e:
            logger.error(f"路由自检出错: {e}")

def sync_database_schema(app):
    """尽量同步数据库结构，并准确说明同步能力边界。

    - Alembic upgrade: 负责真正的结构迁移（新增列、删列、索引等）
    - db.create_all(): 只负责补齐缺失表，不会修改已有表结构
    """
    repo_root = Path(app.root_path).parent
    versions_dir = repo_root / "migrations" / "versions"
    version_files = sorted(
        path for path in versions_dir.glob("*.py")
        if path.is_file() and path.name != "__init__.py"
    )

    inspector = inspect(db.engine)
    tables_before = set(inspector.get_table_names())

    if version_files:
        try:
            from flask_migrate import upgrade
            upgrade()

            current_revision = None
            tables_after_upgrade = set(inspect(db.engine).get_table_names())
            if "alembic_version" in tables_after_upgrade:
                current_revision = db.session.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar()

            if current_revision:
                print(f"  [✓] Alembic 迁移已同步到版本: {current_revision}")
            else:
                print("  [✓] Alembic 迁移检查已完成")
        except Exception:
            logger.exception("Alembic 自动升级失败")
            print("  [!] Alembic 自动升级失败，将回退为仅补齐缺失表。")
            print("      注意: `create_all()` 不会修改已有列、索引或约束。")
    else:
        logger.warning("未发现迁移脚本，跳过 Alembic upgrade。")
        print("  [i] 未发现迁移脚本，跳过 Alembic upgrade。")

    db.create_all()

    tables_after = set(inspect(db.engine).get_table_names())
    created_tables = sorted(tables_after - tables_before)
    if created_tables:
        print(f"  [i] 已补齐缺失表: {', '.join(created_tables)}")

def check_route_shadowing(app):
    """检查静态路由是否真的会被其他规则截获。

    旧逻辑按定义顺序猜测“变量路由会遮挡静态路由”，
    但 Flask/Werkzeug 实际会按规则优先级匹配，静态段通常优先于变量段。
    因此这里改为：直接用路由匹配器验证静态路径最终命中了哪条规则。
    """
    adapter = app.url_map.bind("localhost")
    reported = set()

    for rule in app.url_map.iter_rules():
        # 只检查完全静态的 URL；这类路由可以直接用真实路径验证是否可达。
        if rule.arguments:
            continue

        methods = {
            method for method in (rule.methods or set())
            if method not in {"HEAD", "OPTIONS"}
        }
        if not methods:
            methods = {"GET"}

        for method in methods:
            try:
                matched_rule, _ = adapter.match(
                    rule.rule,
                    method=method,
                    return_rule=True
                )
            except (NotFound, MethodNotAllowed, RequestRedirect):
                continue
            except Exception as e:
                logger.debug("路由匹配验证失败 %s %s: %s", method, rule.rule, e)
                continue

            if matched_rule.rule == rule.rule and matched_rule.endpoint == rule.endpoint:
                continue

            key = (matched_rule.rule, rule.rule, method)
            if key in reported:
                continue
            reported.add(key)

            print("\n" + "!" * 50)
            print(" [路由警告] 发现真实的路由可达性冲突:")
            print(f" 实际命中: {matched_rule.rule} -> {matched_rule.endpoint} [{method}]")
            print(f" 预期路由: {rule.rule} -> {rule.endpoint} [{method}]")
            print(" 说明: 访问该静态路径时，Flask 没有命中预期规则，请检查路由设计。")
            print("!" * 50 + "\n")

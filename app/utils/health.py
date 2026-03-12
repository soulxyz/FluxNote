import logging
import re
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
    """运行时自动迁移：对比 SQLAlchemy 模型与实际数据库结构，补齐差异。

    策略:
      1. db.create_all() — 补齐缺失的整张表
      2. 逐表对比列 — ALTER TABLE ADD COLUMN 补齐缺失列
      3. 逐表对比索引 — CREATE INDEX 补齐缺失索引

    不做危险操作（不删表、不删列、不改列类型），保证数据安全。
    """
    inspector = inspect(db.engine)
    tables_before = set(inspector.get_table_names())

    # ── 1. 补齐缺失表 ──
    db.create_all()

    inspector = inspect(db.engine)
    tables_after = set(inspector.get_table_names())
    created_tables = sorted(tables_after - tables_before)
    if created_tables:
        logger.info(f"  [✓] 新建表: {', '.join(created_tables)}")

    # ── 2. 补齐缺失列 ──
    col_changes = _sync_missing_columns(inspector)

    # 刷新 inspector 以反映新添加的列
    inspector = inspect(db.engine)

    # ── 3. 补齐缺失索引 ──
    idx_changes = _sync_missing_indexes(inspector)

    if col_changes or idx_changes:
        for msg in col_changes + idx_changes:
            logger.info(f"  [✓] {msg}")
    elif not created_tables:
        logger.info("  [✓] 数据库结构已是最新")


def _sync_missing_columns(inspector):
    """对比模型定义与数据库实际列，补齐缺失列。"""
    changes = []
    existing_tables = set(inspector.get_table_names())
    identifier_pattern = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

    for table in db.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue

        # 验证表名是否为合法标识符
        if not identifier_pattern.match(table.name):
            logger.warning(f"跳过无效的表名: {table.name}")
            continue

        existing_cols = {col['name'] for col in inspector.get_columns(table.name)}

        for column in table.columns:
            if column.name in existing_cols:
                continue

            # 验证列名是否为合法标识符
            if not identifier_pattern.match(column.name):
                logger.warning(f"跳过无效的列名: {table.name}.{column.name}")
                continue

            col_type = column.type.compile(dialect=db.engine.dialect)

            # 检测显式默认值（不合成安全占位符）
            default_clause = _resolve_default_clause(column, col_type)
            
            # 如果是 NOT NULL 且无显式默认值，记录警告
            if not column.nullable and default_clause is None:
                logger.warning(
                    f"列 {table.name}.{column.name} ({col_type}) 定义为 NOT NULL 但无默认值，"
                    f"需要在迁移时处理数据回填"
                )
            
            nullable = column.nullable
            null_str = "" if nullable else " NOT NULL"
            default_str = f" DEFAULT {default_clause}" if default_clause is not None else ""

            # 使用 dialect preparer 正确引用标识符
            preparer = db.engine.dialect.identifier_preparer
            quoted_table = preparer.quote(table.name)
            quoted_column = preparer.quote(column.name)
            
            sql = f'ALTER TABLE {quoted_table} ADD COLUMN {quoted_column} {col_type}{null_str}{default_str}'

            try:
                with db.engine.begin() as conn:
                    conn.execute(text(sql))
                changes.append(f"新增列 {table.name}.{column.name}")
            except Exception as e:
                logger.warning(f"无法添加列 {table.name}.{column.name}: {e}")

    return changes


def _resolve_default_clause(column, col_type_str):
    """检测列的显式默认值（server_default 或静态 default）。

    返回 SQL 片段字符串（不含 DEFAULT 关键字），或 None 表示无显式默认值。
    不会为 NOT NULL 列合成安全占位符。
    """
    # 先检查 server_default
    if column.server_default is not None:
        sd = column.server_default
        if hasattr(sd, 'arg'):
            arg = sd.arg
            if hasattr(arg, 'text'):
                return str(arg.text)
            if isinstance(arg, str):
                # 转义单引号:将 ' 替换为 ''
                escaped_arg = arg.replace("'", "''")
                return f"'{escaped_arg}'"
            return str(arg)
        return str(sd)

    # 再检查 Python 侧 default（只取静态值，callable 的 default 无法用于 DDL）
    if column.default is not None and not column.default.is_callable and not column.default.is_clause_element:
        val = column.default.arg
        if isinstance(val, bool):
            return "1" if val else "0"
        if isinstance(val, (int, float)):
            return str(val)
        if isinstance(val, str):
            # 转义单引号:将 ' 替换为 ''
            escaped_val = val.replace("'", "''")
            return f"'{escaped_val}'"

    # 无显式默认值时返回 None，不合成安全占位符
    return None


def _sync_missing_indexes(inspector):
    """对比模型定义与数据库实际索引，补齐缺失索引。"""
    changes = []
    existing_tables = set(inspector.get_table_names())

    for table in db.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue

        existing_idx_names = {idx['name'] for idx in inspector.get_indexes(table.name) if idx.get('name')}
        db_columns = {col['name'] for col in inspector.get_columns(table.name)}

        for index in table.indexes:
            if not index.name or index.name in existing_idx_names:
                continue

            idx_cols = [col.name for col in index.columns]
            if not all(c in db_columns for c in idx_cols):
                continue

            cols_sql = ', '.join(f'"{c}"' for c in idx_cols)
            unique = "UNIQUE " if index.unique else ""
            sql = f'CREATE {unique}INDEX IF NOT EXISTS "{index.name}" ON "{table.name}" ({cols_sql})'

            try:
                with db.engine.begin() as conn:
                    conn.execute(text(sql))
                changes.append(f"新增索引 {table.name}.{index.name}")
            except Exception as e:
                logger.warning(f"无法创建索引 {index.name}: {e}")

    return changes


def check_route_shadowing(app):
    """检查静态路由是否真的会被其他规则截获。

    旧逻辑按定义顺序猜测"变量路由会遮挡静态路由"，
    但 Flask/Werkzeug 实际会按规则优先级匹配，静态段通常优先于变量段。
    因此这里改为：直接用路由匹配器验证静态路径最终命中了哪条规则。
    """
    adapter = app.url_map.bind("localhost")
    reported = set()

    for rule in app.url_map.iter_rules():
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

            logger.warning("\n" + "!" * 50)
            logger.warning(" [路由警告] 发现真实的路由可达性冲突:")
            logger.warning(f" 实际命中: {matched_rule.rule} -> {matched_rule.endpoint} [{method}]")
            logger.warning(f" 预期路由: {rule.rule} -> {rule.endpoint} [{method}]")
            logger.warning(" 说明: 访问该静态路径时，Flask 没有命中预期规则，请检查路由设计。")
            logger.warning("!" * 50 + "\n")

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
        print(f"  [✓] 新建表: {', '.join(created_tables)}")

    # ── 2. 补齐缺失列 ──
    col_changes = _sync_missing_columns(inspector)

    # ── 3. 补齐缺失索引 ──
    idx_changes = _sync_missing_indexes(inspector)

    if col_changes or idx_changes:
        for msg in col_changes + idx_changes:
            print(f"  [✓] {msg}")
    elif not created_tables:
        print("  [✓] 数据库结构已是最新")


def _sync_missing_columns(inspector):
    """对比模型定义与数据库实际列，补齐缺失列。"""
    changes = []
    existing_tables = set(inspector.get_table_names())

    for table in db.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue

        existing_cols = {col['name'] for col in inspector.get_columns(table.name)}

        for column in table.columns:
            if column.name in existing_cols:
                continue

            col_type = column.type.compile(dialect=db.engine.dialect)

            # SQLite ADD COLUMN 限制: NOT NULL 必须有默认值
            default_clause = _resolve_default_clause(column, col_type)
            nullable = column.nullable or default_clause is None
            null_str = "" if nullable else " NOT NULL"
            default_str = f" DEFAULT {default_clause}" if default_clause is not None else ""

            sql = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type}{null_str}{default_str}'

            try:
                with db.engine.begin() as conn:
                    conn.execute(text(sql))
                changes.append(f"新增列 {table.name}.{column.name}")
            except Exception as e:
                logger.warning(f"无法添加列 {table.name}.{column.name}: {e}")

    return changes


def _resolve_default_clause(column, col_type_str):
    """为 ALTER TABLE ADD COLUMN 生成 SQLite 兼容的 DEFAULT 子句值。

    返回 SQL 片段字符串（不含 DEFAULT 关键字），或 None 表示无默认值。
    """
    # 先检查 server_default
    if column.server_default is not None:
        sd = column.server_default
        if hasattr(sd, 'arg'):
            arg = sd.arg
            if hasattr(arg, 'text'):
                return str(arg.text)
            return f"'{arg}'" if isinstance(arg, str) else str(arg)
        return str(sd)

    # 再检查 Python 侧 default（只取静态值，callable 的 default 无法用于 DDL）
    if column.default is not None and not column.default.is_callable and not column.default.is_clause_element:
        val = column.default.arg
        if isinstance(val, bool):
            return "1" if val else "0"
        if isinstance(val, (int, float)):
            return str(val)
        if isinstance(val, str):
            return f"'{val}'"

    # 对 NOT NULL 且无静态默认值的列，按类型给一个安全默认值
    if not column.nullable:
        upper = col_type_str.upper()
        if 'BOOL' in upper:
            return "0"
        if any(t in upper for t in ('INT', 'FLOAT', 'REAL', 'NUMERIC', 'DECIMAL')):
            return "0"
        return "''"

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

            print("\n" + "!" * 50)
            print(" [路由警告] 发现真实的路由可达性冲突:")
            print(f" 实际命中: {matched_rule.rule} -> {matched_rule.endpoint} [{method}]")
            print(f" 预期路由: {rule.rule} -> {rule.endpoint} [{method}]")
            print(" 说明: 访问该静态路径时，Flask 没有命中预期规则，请检查路由设计。")
            print("!" * 50 + "\n")

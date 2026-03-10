import logging
from logging.config import fileConfig

from flask import current_app

from alembic import context

# this is the Alembic Config object, which provides
# access to the values within the .ini file in use.
config = context.config

# Interpret the config file for Python logging.
# This line sets up loggers basically.
fileConfig(config.config_file_name)
logger = logging.getLogger('alembic.env')


def get_engine():
    """
    Retrieve the SQLAlchemy Engine instance provided by the Flask-Migrate extension.
    
    This obtains the engine from current_app.extensions['migrate'].db and is compatible with both Flask-SQLAlchemy versions that expose db.get_engine() (pre-3) and those that expose db.engine (3 and later).
    
    Returns:
        engine: The SQLAlchemy Engine instance used by the application.
    """
    try:
        # this works with Flask-SQLAlchemy<3 and Alchemical
        return current_app.extensions['migrate'].db.get_engine()
    except (TypeError, AttributeError):
        # this works with Flask-SQLAlchemy>=3
        return current_app.extensions['migrate'].db.engine


def get_engine_url():
    """
    SQLAlchemy engine URL string suitable for use in Alembic configuration.
    
    Renders the application's engine URL (including credentials when available) and escapes percent signs by doubling them so the string can be safely set as Alembic's `sqlalchemy.url` option.
    
    Returns:
        str: Engine URL with password preserved when possible and all '%' characters replaced with '%%'.
    """
    try:
        return get_engine().url.render_as_string(hide_password=False).replace(
            '%', '%%')
    except AttributeError:
        return str(get_engine().url).replace('%', '%%')


# add your model's MetaData object here
# for 'autogenerate' support
# from myapp import mymodel
# target_metadata = mymodel.Base.metadata
config.set_main_option('sqlalchemy.url', get_engine_url())
target_db = current_app.extensions['migrate'].db

# other values from the config, defined by the needs of env.py,
# can be acquired:
# my_important_option = config.get_main_option("my_important_option")
# ... etc.


def get_metadata():
    """
    Return the SQLAlchemy MetaData object used as the autogeneration target.
    
    When the application's database object exposes multiple metadatas (via a `metadatas` mapping),
    the default metadata at key None is returned; otherwise the `metadata` attribute is returned.
    
    Returns:
        sqlalchemy.MetaData: MetaData instance to use for Alembic autogeneration.
    """
    if hasattr(target_db, 'metadatas'):
        return target_db.metadatas[None]
    return target_db.metadata


def run_migrations_offline():
    """
    Configure Alembic for URL-based (offline) migrations and run them.
    
    Configures the Alembic context using the configured SQLAlchemy URL and the module's target metadata with literal binds enabled, then executes migrations inside a transaction without creating or requiring a live DB engine.
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url, target_metadata=get_metadata(), literal_binds=True
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    """
    Execute Alembic migrations using a live database connection.
    
    Configures Alembic to use a connection obtained from the application's Flask-Migrate integration, ensures a `process_revision_directives` callback is registered to skip generating empty autogenerate revisions, sets the target metadata, and runs migrations inside a transaction.
    """

    # this callback is used to prevent an auto-migration from being generated
    # when there are no changes to the schema
    # reference: http://alembic.zzzcomputing.com/en/latest/cookbook.html
    def process_revision_directives(context, revision, directives):
        """
        Skip writing an empty autogenerate revision when no schema changes are detected.
        
        When Alembic autogeneration is enabled, inspects the first revision directive's upgrade operations; if those operations are empty, clears the directives list to prevent emitting an empty migration file and logs an informational message.
        
        Parameters:
            context: The Alembic migration context provided to the callback.
            revision: The target revision identifier (passed by Alembic; unused by this callback).
            directives (list): The list of generated revision directives; the function may modify this list in-place.
        """
        if getattr(config.cmd_opts, 'autogenerate', False):
            script = directives[0]
            if script.upgrade_ops.is_empty():
                directives[:] = []
                logger.info('No changes in schema detected.')

    conf_args = current_app.extensions['migrate'].configure_args
    if conf_args.get("process_revision_directives") is None:
        conf_args["process_revision_directives"] = process_revision_directives

    connectable = get_engine()

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=get_metadata(),
            **conf_args
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

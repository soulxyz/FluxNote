from flask import Blueprint, jsonify
from flask_login import current_user, login_required
from app.models import Note, db
from sqlalchemy import func
from datetime import datetime, timedelta
from app.utils.cache import cached

stats_bp = Blueprint('stats', __name__)

@stats_bp.route('/api/stats/heatmap', methods=['GET'])
@cached(ttl=600)
def get_heatmap_data():
    """
    Get note counts per day for the last 365 days.
    Returns: { "2023-01-01": 5, "2023-01-02": 2, ... }
    """
    # Calculate date range
    end_date = datetime.now()
    start_date = end_date - timedelta(days=365)

    query = db.session.query(
        func.strftime('%Y-%m-%d', Note.created_at).label('date'),
        func.count(Note.id).label('count')
    )

    if current_user.is_authenticated:
        # User's own notes + Public notes? Or just User's own?
        # Usually heatmap tracks "My Activity".
        # For anonymous, we show public notes activity.
        query = query.filter(
            Note.user_id == current_user.id,
            Note.is_deleted == False,
            Note.created_at >= start_date
        )
    else:
        # Public activity
        query = query.filter(
            Note.is_public == True,
            Note.is_deleted == False,
            Note.created_at >= start_date
        )

    query = query.group_by('date').all()

    # Format result as a dictionary
    result = {row.date: row.count for row in query}

    return jsonify(result)

@stats_bp.route('/api/stats/overview', methods=['GET'])
@cached(ttl=600)
def get_overview():
    """
    Get overview stats: total notes, total tags, active days.
    """
    if current_user.is_authenticated:
        # Total notes
        total_notes = Note.query.filter_by(user_id=current_user.id).count()

        # Total tags
        from app.models import note_tags
        total_tags = db.session.query(func.count(func.distinct(note_tags.c.tag_id)))\
            .join(Note, Note.id == note_tags.c.note_id)\
            .filter(Note.user_id == current_user.id)\
            .scalar() or 0

        # Active days
        active_days = db.session.query(func.count(func.distinct(func.date(Note.created_at))))\
            .filter(Note.user_id == current_user.id)\
            .scalar() or 0

    else:
        # Public Stats
        total_notes = Note.query.filter_by(is_public=True).count()

        from app.models import note_tags
        total_tags = db.session.query(func.count(func.distinct(note_tags.c.tag_id)))\
            .join(Note, Note.id == note_tags.c.note_id)\
            .filter(Note.is_public == True)\
            .scalar() or 0

        active_days = db.session.query(func.count(func.distinct(func.date(Note.created_at))))\
            .filter(Note.is_public == True)\
            .scalar() or 0

    return jsonify({
        'notes': total_notes,
        'tags': total_tags,
        'days': active_days
    })

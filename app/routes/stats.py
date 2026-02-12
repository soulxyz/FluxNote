from flask import Blueprint, jsonify
from flask_login import current_user, login_required
from app.models import Note, db
from sqlalchemy import func
from datetime import datetime, timedelta

stats_bp = Blueprint('stats', __name__)

@stats_bp.route('/api/stats/heatmap', methods=['GET'])
@login_required
def get_heatmap_data():
    """
    Get note counts per day for the last 365 days.
    Returns: { "2023-01-01": 5, "2023-01-02": 2, ... }
    """
    # Calculate date range
    end_date = datetime.now()
    start_date = end_date - timedelta(days=365)

    # Query database
    # Group by date(created_at) and count
    # SQLite uses strftime for date formatting
    query = db.session.query(
        func.strftime('%Y-%m-%d', Note.created_at).label('date'),
        func.count(Note.id).label('count')
    ).filter(
        Note.user_id == current_user.id,
        Note.created_at >= start_date
    ).group_by(
        'date'
    ).all()

    # Format result as a dictionary
    result = {row.date: row.count for row in query}

    return jsonify(result)

@stats_bp.route('/api/stats/overview', methods=['GET'])
@login_required
def get_overview():
    """
    Get overview stats: total notes, total tags, active days.
    """
    # Total notes
    total_notes = Note.query.filter_by(user_id=current_user.id).count()

    # Total tags (approximate or exact query)
    # Since we use tags relationship now, we can query distinct tags for this user's notes
    # But for performance/simplicity, let's just count unique tags used in notes
    # OR if we have a user-tag relationship. We don't really. Tags are global or shared?
    # Looking at models.py: Tag is global. Note-Tag is many-to-many.
    # We should count tags associated with user's notes.
    # query:
    # select count(distinct tag_id) from note_tags join note on note.id = note_tags.note_id where note.user_id = ...
    # SQLAlchemy way:
    from app.models import note_tags, Tag
    total_tags = db.session.query(func.count(func.distinct(note_tags.c.tag_id)))\
        .join(Note, Note.id == note_tags.c.note_id)\
        .filter(Note.user_id == current_user.id)\
        .scalar()

    # Active days (count of distinct dates created_at)
    active_days = db.session.query(func.count(func.distinct(func.date(Note.created_at))))\
        .filter(Note.user_id == current_user.id)\
        .scalar()

    return jsonify({
        'notes': total_notes,
        'tags': total_tags or 0,
        'days': active_days or 0
    })

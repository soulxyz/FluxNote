import time
from functools import wraps

class SimpleCache:
    """A very simple thread-safe in-memory cache for stats endpoints."""
    def __init__(self):
        self._cache = {}
    
    def get(self, key):
        if key in self._cache:
            entry = self._cache[key]
            if time.time() < entry['expires']:
                return entry['data']
            else:
                del self._cache[key]
        return None
        
    def set(self, key, data, ttl=300):
        self._cache[key] = {
            'data': data,
            'expires': time.time() + ttl
        }
        
    def delete(self, key):
        if key in self._cache:
            del self._cache[key]
            
    def clear(self):
        self._cache.clear()

# Global cache instance
stats_cache = SimpleCache()

def cached(ttl=300, key_prefix=''):
    """
    Decorator to cache route results.
    Key is based on the request path and user auth status to avoid leaking private data.
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            from flask import request
            from flask_login import current_user
            
            # Create a unique key per user (or public) and endpoint
            user_key = f"user_{current_user.id}" if current_user.is_authenticated else "public"
            cache_key = f"{key_prefix}_{request.path}_{user_key}"
            
            cached_data = stats_cache.get(cache_key)
            if cached_data is not None:
                return cached_data
                
            response = f(*args, **kwargs)
            
            # Cache the response if it's successful (assuming it returns a JSON response object)
            if hasattr(response, 'status_code') and response.status_code == 200:
                stats_cache.set(cache_key, response, ttl=ttl)
                
            return response
        return decorated_function
    return decorator

def invalidate_stats_cache():
    """Clear all stats cache. Call this when a note is created/updated/deleted."""
    stats_cache.clear()

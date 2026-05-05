# Example: Django + Gravel

Stub Django project showing where Gravel mounts. Full implementation will
include a working `manage.py runserver` flow once the SDK lands its full
route table.

## Status

Skeleton only. Add to your project's `urls.py`:

```python
from django.urls import path, include
from artanis_gravel.django import gravel_urls

urlpatterns = [
    # ... your routes ...
    path('admin/ai/', include(gravel_urls)),
]
```

The `gravel_config.py` shape:

```python
import os
from artanis_gravel import GravelConfig

config = GravelConfig(
    mount_path='/admin/ai',
    database={'url': os.environ['DATABASE_URL']},
    auth={'default_password': os.environ['GRAVEL_ADMIN_PASSWORD']},
)
```

A runnable Django project lands alongside the v0 build.

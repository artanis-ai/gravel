# Example: Django + Gravel

Minimal Django project showing where Gravel mounts. The actual `manage.py
runserver` flow ships with v0.5.x; this directory documents the wiring
without bundling a full demo app.

Add to your project's `urls.py`:

```python
from django.urls import path, include
from artanis_gravel.django import gravel_urls
from gravel_config import config

urlpatterns = [
    # ... your routes ...
    path('admin/ai/', include(gravel_urls(config))),
]
```

`gravel_urls` returns a list of URL patterns (root + catch-all) that
delegate to the shared `_handler.py` dispatcher, so every dashboard route
(`/admin/ai/api/auth/me`, `/admin/ai/api/prompts`, `/admin/ai/api/samples`,
GitHub install flow, etc.) reaches the same code path as FastAPI / Flask /
raw ASGI hosts.

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

For a runnable end-to-end Django host see the
[`py-django-pipenv-pg`](https://github.com/artanis-ai/gravel-test-fixtures/tree/main/py-django-pipenv-pg)
fixture in the public test-fixtures repo.

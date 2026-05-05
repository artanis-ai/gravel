import os

from artanis_gravel import GravelConfig

config = GravelConfig(
    mount_path="/admin/ai",
    database={"url": os.environ["DATABASE_URL"]},
    auth={"default_password": os.environ["GRAVEL_ADMIN_PASSWORD"]},
)

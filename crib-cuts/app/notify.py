"""Phone notifications through the free ntfy app (subscribe to your NTFY_TOPIC)."""
import requests
from . import config


def push(title, message, click=None, priority="default"):
    if not config.NTFY_TOPIC:
        print(f"[notify] {title}: {message}")
        return
    headers = {"Title": title.encode("latin-1", "replace").decode("latin-1"), "Priority": priority, "Tags": "clapper"}
    if click:
        headers["Click"] = click
    try:
        requests.post(f"{config.NTFY_SERVER}/{config.NTFY_TOPIC}", data=message.encode("utf-8"), headers=headers, timeout=15)
    except Exception as e:
        print(f"[notify] failed: {e}")

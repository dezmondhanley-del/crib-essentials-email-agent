"""Google Drive via a service account. Share the Raw Clips + Ready to Post folders with the
service account's email (Editor) and it can read clips and upload finished videos."""
import io, os
from . import config

VIDEO_OR_IMAGE = "(mimeType contains 'video/' or mimeType contains 'image/')"
_svc = None


def service():
    global _svc
    if _svc is None:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        info = config.service_account_info()
        if not info:
            raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON is not set")
        creds = service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/drive"])
        _svc = build("drive", "v3", credentials=creds, cache_discovery=False)
    return _svc


def list_media(folder_id):
    """All videos/images in a folder (and one level of subfolders)."""
    out, folders = [], [folder_id]
    s = service()
    sub = s.files().list(q=f"'{folder_id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
                         fields="files(id)", pageSize=200, supportsAllDrives=True, includeItemsFromAllDrives=True).execute()
    folders += [f["id"] for f in sub.get("files", [])]
    for fid in folders:
        token = None
        while True:
            r = s.files().list(q=f"'{fid}' in parents and trashed=false and {VIDEO_OR_IMAGE}",
                               fields="nextPageToken, files(id,name,mimeType,size,createdTime,videoMediaMetadata)",
                               pageSize=200, pageToken=token, supportsAllDrives=True,
                               includeItemsFromAllDrives=True).execute()
            out += r.get("files", [])
            token = r.get("nextPageToken")
            if not token:
                break
    return out


def download(file_id, dest):
    from googleapiclient.http import MediaIoBaseDownload
    req = service().files().get_media(fileId=file_id, supportsAllDrives=True)
    with io.FileIO(dest, "wb") as fh:
        dl = MediaIoBaseDownload(fh, req, chunksize=16 * 1024 * 1024)
        done = False
        while not done:
            _, done = dl.next_chunk()
    return dest


def upload(path, folder_id, name, mime="video/mp4"):
    from googleapiclient.http import MediaFileUpload
    media = MediaFileUpload(path, mimetype=mime, resumable=True)
    f = service().files().create(body={"name": name, "parents": [folder_id]}, media_body=media,
                                 fields="id, webViewLink", supportsAllDrives=True).execute()
    return f

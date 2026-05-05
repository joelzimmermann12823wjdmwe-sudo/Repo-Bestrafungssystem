const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY;

if (!CLIENT_EMAIL || !PRIVATE_KEY) {
    console.log('[Drive] Google Drive deaktiviert (fehlende Credentials)');
}

let drive;
function getDrive() {
    if (drive) return drive;
    if (!CLIENT_EMAIL || !PRIVATE_KEY) return null;

    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: CLIENT_EMAIL,
            private_key: PRIVATE_KEY.replace(/\\n/g, '\n'),
        },
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });

    drive = google.drive({ version: 'v3', auth });
    return drive;
}

async function ensureFolderExists(drive, folderName) {
    const res = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
        fields: 'files(id, name)',
    });

    if (res.data.files.length > 0) {
        return res.data.files[0].id;
    }

    const folder = await drive.files.create({
        requestBody: {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: GOOGLE_DRIVE_FOLDER_ID ? [GOOGLE_DRIVE_FOLDER_ID] : undefined,
        },
        fields: 'id',
    });

    return folder.data.id;
}

async function uploadToGoogleDrive(folderPath, folderName) {
    const drive = getDrive();
    if (!drive) {
        console.log('[Drive] Upload skipped (nicht konfiguriert)');
        return null;
    }

    try {
        console.log(`[Drive] Erstelle/finde Folder: ${folderName}`);
        const parentFolderId = await ensureFolderExists(drive, folderName);

        const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.wav'));
        if (files.length === 0) {
            console.log('[Drive] Keine WAV-Dateien zum Uploaden');
            return null;
        }

        const uploaded = [];
        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stats = fs.statSync(filePath);

            console.log(`[Drive] Upload: ${file} (${(stats.size / 1024).toFixed(1)} KB)`);

            const media = {
                mimeType: 'audio/wav',
                body: fs.createReadStream(filePath),
            };

            const res = await drive.files.create({
                requestBody: {
                    name: file,
                    parents: [parentFolderId],
                },
                media,
                fields: 'id, name, webViewLink',
            });

            uploaded.push({
                name: res.data.name,
                id: res.data.id,
                url: res.data.webViewLink,
            });
        }

        console.log(`[Drive] ${uploaded.length} Dateien hochgeladen`);
        return uploaded;
    } catch (err) {
        console.error(`[Drive] Upload fehlgeschlagen: ${err.message}`);
        return null;
    }
}

module.exports = { uploadToGoogleDrive };
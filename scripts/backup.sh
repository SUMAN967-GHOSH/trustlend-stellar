#!/bin/bash
set -e

# Load env vars
source .env

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="backup_${DATE}.sql"
ENCRYPTED_FILE="backup_${DATE}.sql.gz.gpg"

echo "1. Dumping database..."
pg_dump $DATABASE_URL --schema-only > $BACKUP_FILE

echo "2. Compressing..."
gzip $BACKUP_FILE

echo "3. Encrypting..."
openssl enc -aes-256-cbc -salt -in ${BACKUP_FILE}.gz -out $ENCRYPTED_FILE -k $BACKUP_ENCRYPTION_KEY

echo "4. Uploading to S3..."
aws s3 cp $ENCRYPTED_FILE s3://$S3_BUCKET/backups/

echo "5. Cleanup..."
rm $ENCRYPTED_FILE

echo "✅ Backup complete: $ENCRYPTED_FILE uploaded"
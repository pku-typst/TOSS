use aws_config::BehaviorVersion;
use aws_config::Region;
use aws_credential_types::Credentials;
use aws_sdk_s3::primitives::ByteStream;
use std::env;
use std::str::FromStr;
use thiserror::Error;

#[derive(Clone)]
pub(crate) struct ObjectStorage {
    client: aws_sdk_s3::Client,
    bucket: String,
    key_prefix: String,
}

#[derive(Debug, Error)]
pub(crate) enum ObjectStorageError {
    #[error("object upload request failed")]
    Put(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("object download request failed")]
    Get(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("object download body failed")]
    GetBody(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("object deletion request failed")]
    Delete(#[source] Box<dyn std::error::Error + Send + Sync>),
}

pub async fn init_object_storage_from_env() -> Option<ObjectStorage> {
    let bucket = env::var("S3_BUCKET").ok()?;
    if bucket.trim().is_empty() {
        return None;
    }
    let endpoint = env::var("S3_ENDPOINT").ok();
    let region = env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
    let key_prefix = env::var("S3_KEY_PREFIX").unwrap_or_else(|_| "".to_string());
    let access_key = env::var("S3_ACCESS_KEY_ID")
        .ok()
        .or_else(|| env::var("MINIO_ROOT_USER").ok());
    let secret_key = env::var("S3_SECRET_ACCESS_KEY")
        .ok()
        .or_else(|| env::var("MINIO_ROOT_PASSWORD").ok());

    let shared = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region.clone()))
        .load()
        .await;
    let mut builder = aws_sdk_s3::config::Builder::from(&shared).region(Region::new(region));
    if let Some(ep) = endpoint {
        if let Ok(uri) = http::Uri::from_str(&ep) {
            builder = builder.endpoint_url(uri.to_string()).force_path_style(true);
        }
    }
    if let (Some(ak), Some(sk)) = (access_key, secret_key) {
        builder = builder.credentials_provider(Credentials::new(ak, sk, None, None, "env"));
    }
    let client = aws_sdk_s3::Client::from_conf(builder.build());
    Some(ObjectStorage {
        client,
        bucket,
        key_prefix,
    })
}

fn storage_key(storage: &ObjectStorage, raw: &str) -> String {
    if storage.key_prefix.is_empty() {
        raw.to_string()
    } else {
        format!(
            "{}/{}",
            storage.key_prefix.trim_matches('/'),
            raw.trim_start_matches('/')
        )
    }
}

pub async fn put_object(
    storage: &ObjectStorage,
    key: &str,
    content_type: &str,
    data: Vec<u8>,
) -> Result<(), ObjectStorageError> {
    let final_key = storage_key(storage, key);
    storage
        .client
        .put_object()
        .bucket(&storage.bucket)
        .key(final_key)
        .content_type(content_type)
        .body(ByteStream::from(data))
        .send()
        .await
        .map_err(|source| ObjectStorageError::Put(Box::new(source)))?;
    Ok(())
}

pub async fn get_object(storage: &ObjectStorage, key: &str) -> Result<Vec<u8>, ObjectStorageError> {
    let final_key = storage_key(storage, key);
    let output = storage
        .client
        .get_object()
        .bucket(&storage.bucket)
        .key(final_key)
        .send()
        .await
        .map_err(|source| ObjectStorageError::Get(Box::new(source)))?;
    let bytes = output
        .body
        .collect()
        .await
        .map_err(|source| ObjectStorageError::GetBody(Box::new(source)))?
        .into_bytes()
        .to_vec();
    Ok(bytes)
}

pub async fn delete_object(storage: &ObjectStorage, key: &str) -> Result<(), ObjectStorageError> {
    let final_key = storage_key(storage, key);
    storage
        .client
        .delete_object()
        .bucket(&storage.bucket)
        .key(final_key)
        .send()
        .await
        .map_err(|source| ObjectStorageError::Delete(Box::new(source)))?;
    Ok(())
}

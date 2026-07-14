//! Password hashing and verification isolated from async request execution.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use thiserror::Error;

#[derive(Debug, Error)]
pub(super) enum PasswordHashError {
    #[error("Argon2 password hashing failed")]
    HashFailed(#[source] argon2::password_hash::Error),
    #[error("password hashing task failed")]
    TaskFailed(#[source] tokio::task::JoinError),
}

#[derive(Debug, Error)]
pub(super) enum PasswordVerificationError {
    #[error("stored password hash is invalid")]
    CorruptHash(#[source] argon2::password_hash::Error),
    #[error("password verification task failed")]
    TaskFailed(#[source] tokio::task::JoinError),
}

pub(super) async fn hash(raw: String) -> Result<String, PasswordHashError> {
    tokio::task::spawn_blocking(move || hash_blocking(&raw))
        .await
        .map_err(PasswordHashError::TaskFailed)?
}

pub(super) async fn verify(
    raw: String,
    encoded_hash: String,
) -> Result<bool, PasswordVerificationError> {
    tokio::task::spawn_blocking(move || verify_blocking(&raw, &encoded_hash))
        .await
        .map_err(PasswordVerificationError::TaskFailed)?
}

fn hash_blocking(raw: &str) -> Result<String, PasswordHashError> {
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(raw.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(PasswordHashError::HashFailed)
}

fn verify_blocking(raw: &str, encoded_hash: &str) -> Result<bool, PasswordVerificationError> {
    let parsed = PasswordHash::new(encoded_hash).map_err(PasswordVerificationError::CorruptHash)?;
    Ok(Argon2::default()
        .verify_password(raw.as_bytes(), &parsed)
        .is_ok())
}

#[cfg(test)]
mod tests {
    use super::{hash, verify, PasswordVerificationError};

    #[tokio::test]
    async fn password_adapter_round_trips_and_rejects_corrupt_hashes() -> Result<(), &'static str> {
        let encoded = match hash("correct horse battery staple".to_string()).await {
            Ok(encoded) => encoded,
            Err(_) => return Err("password hashing failed"),
        };
        assert!(matches!(
            verify("correct horse battery staple".to_string(), encoded.clone()).await,
            Ok(true)
        ));
        assert!(matches!(
            verify("incorrect".to_string(), encoded).await,
            Ok(false)
        ));
        assert!(matches!(
            verify("password".to_string(), "not-a-password-hash".to_string()).await,
            Err(PasswordVerificationError::CorruptHash(_))
        ));
        Ok(())
    }
}

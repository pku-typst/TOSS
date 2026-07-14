//! Encryption boundary for persisted provider credentials.

use super::super::provider::ExternalGitProvider;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use thiserror::Error;
use uuid::Uuid;

const TOKEN_BLOB_VERSION: u8 = 1;
const TOKEN_NONCE_BYTES: usize = 12;

#[derive(Debug, Error)]
pub(crate) enum TokenCipherError {
    #[error("token plaintext is empty")]
    EmptyPlaintext,
    #[error("token encryption key is invalid")]
    InvalidKey,
    #[error("token encryption failed")]
    Encryption,
    #[error("token ciphertext is empty")]
    EmptyCiphertext,
    #[error("token ciphertext version {version} is unsupported")]
    UnsupportedVersion { version: u8 },
    #[error("token ciphertext is malformed")]
    MalformedCiphertext,
    #[error("token decryption failed")]
    Decryption,
    #[error("decrypted token is not valid UTF-8")]
    InvalidUtf8 {
        #[source]
        source: std::string::FromUtf8Error,
    },
}

pub(super) fn encrypt_token(
    provider: &ExternalGitProvider,
    user_id: Uuid,
    plaintext: &str,
) -> Result<Vec<u8>, TokenCipherError> {
    if plaintext.is_empty() {
        return Err(TokenCipherError::EmptyPlaintext);
    }
    let cipher = Aes256Gcm::new_from_slice(provider.token_encryption_key())
        .map_err(|_| TokenCipherError::InvalidKey)?;
    let mut nonce_bytes = [0u8; TOKEN_NONCE_BYTES];
    rand::fill(&mut nonce_bytes);
    let nonce = Nonce::from(nonce_bytes);
    let aad = provider.credential_aad(user_id);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| TokenCipherError::Encryption)?;
    let mut blob = Vec::with_capacity(1 + TOKEN_NONCE_BYTES + ciphertext.len());
    blob.push(TOKEN_BLOB_VERSION);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

pub(super) fn decrypt_token(
    provider: &ExternalGitProvider,
    user_id: Uuid,
    blob: &[u8],
) -> Result<String, TokenCipherError> {
    let Some((&version, payload)) = blob.split_first() else {
        return Err(TokenCipherError::EmptyCiphertext);
    };
    if version != TOKEN_BLOB_VERSION {
        return Err(TokenCipherError::UnsupportedVersion { version });
    }
    let Some((nonce_slice, ciphertext)) = payload.split_at_checked(TOKEN_NONCE_BYTES) else {
        return Err(TokenCipherError::MalformedCiphertext);
    };
    if ciphertext.is_empty() {
        return Err(TokenCipherError::MalformedCiphertext);
    }
    let cipher = Aes256Gcm::new_from_slice(provider.token_encryption_key())
        .map_err(|_| TokenCipherError::InvalidKey)?;
    let mut nonce_bytes = [0u8; TOKEN_NONCE_BYTES];
    nonce_bytes.copy_from_slice(nonce_slice);
    let nonce = Nonce::from(nonce_bytes);
    let aad = provider.credential_aad(user_id);
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| TokenCipherError::Decryption)?;
    String::from_utf8(plaintext).map_err(|source| TokenCipherError::InvalidUtf8 { source })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_repositories::provider::{
        OAuth2GitProvider, OAuth2GitProviderConfig, ProviderBrand, RepositoryApiDialect,
    };
    use std::sync::Arc;

    fn provider(
        key: [u8; 32],
    ) -> Result<
        ExternalGitProvider,
        crate::external_repositories::provider::InvalidProviderInstanceId,
    > {
        Ok(ExternalGitProvider::oauth2(
            "gitlab".parse()?,
            "GitLab".to_string(),
            ProviderBrand::GitLab,
            false,
            OAuth2GitProvider::new(OAuth2GitProviderConfig {
                base_url: "https://gitlab.example.com".to_string(),
                api_url: "https://gitlab.example.com/api/v4".to_string(),
                api: RepositoryApiDialect::GitLab,
                client_id: "client-id".to_string(),
                client_secret: "client-secret".to_string(),
                redirect_uri:
                    "https://collab.example.test/v1/external-git/providers/gitlab/callback"
                        .to_string(),
                token_encryption_key: Arc::new(key),
                http_client: reqwest::Client::new(),
            }),
        ))
    }

    #[test]
    fn token_encryption_round_trips_and_uses_a_random_nonce(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let provider = provider([7u8; 32])?;
        let user_id = Uuid::new_v4();
        let first = encrypt_token(&provider, user_id, "secret-token")?;
        let second = encrypt_token(&provider, user_id, "secret-token")?;
        assert_ne!(first, second);
        assert_eq!(decrypt_token(&provider, user_id, &first)?, "secret-token");
        assert_eq!(decrypt_token(&provider, user_id, &second)?, "secret-token");
        Ok(())
    }

    #[test]
    fn token_encryption_rejects_tampering_and_row_swaps() -> Result<(), Box<dyn std::error::Error>>
    {
        let provider = provider([9u8; 32])?;
        let user_id = Uuid::new_v4();
        let other_user_id = Uuid::new_v4();
        let mut encrypted = encrypt_token(&provider, user_id, "secret-token")?;
        let last = encrypted
            .last_mut()
            .ok_or(TokenCipherError::MalformedCiphertext)?;
        *last ^= 0x01;
        assert!(decrypt_token(&provider, user_id, &encrypted).is_err());

        let encrypted = encrypt_token(&provider, user_id, "secret-token")?;
        assert!(decrypt_token(&provider, other_user_id, &encrypted).is_err());
        assert!(decrypt_token(&provider, user_id, &[]).is_err());
        let missing_ciphertext = vec![TOKEN_BLOB_VERSION; 1 + TOKEN_NONCE_BYTES];
        assert!(decrypt_token(&provider, user_id, &missing_ciphertext).is_err());
        Ok(())
    }
}

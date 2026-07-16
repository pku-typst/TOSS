//! Local account login workflow and policy.

use super::{password, persistence};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub(super) enum LocalLoginPolicyError {
    #[error("local account login is disabled")]
    Disabled,
    #[error("email and password are required")]
    MissingCredentials,
}

#[derive(Debug, Error)]
pub(super) enum AuthenticateLocalAccountError {
    #[error(transparent)]
    Policy(#[from] LocalLoginPolicyError),
    #[error("email or password is incorrect")]
    IncorrectCredentials,
    #[error("local account credential lookup failed")]
    CredentialStoreUnavailable(#[source] sqlx::Error),
    #[error("local account password verification failed")]
    PasswordVerification(#[source] password::PasswordVerificationError),
}

pub(super) struct LocalLoginCommand {
    pub email: String,
    pub password: String,
}

struct ValidatedLocalLogin {
    email: String,
    password: String,
}

pub(super) async fn authenticate(
    db: &PgPool,
    enabled: bool,
    command: LocalLoginCommand,
) -> Result<Uuid, AuthenticateLocalAccountError> {
    let login = validate(enabled, command)?;
    let credentials = persistence::credentials_by_email(db, &login.email)
        .await
        .map_err(AuthenticateLocalAccountError::CredentialStoreUnavailable)?
        .ok_or(AuthenticateLocalAccountError::IncorrectCredentials)?;
    let user_id = credentials.user_id;
    let password_valid = password::verify(login.password, credentials.password_hash)
        .await
        .map_err(AuthenticateLocalAccountError::PasswordVerification)?;
    if !password_valid {
        return Err(AuthenticateLocalAccountError::IncorrectCredentials);
    }
    Ok(user_id)
}

fn validate(
    enabled: bool,
    command: LocalLoginCommand,
) -> Result<ValidatedLocalLogin, LocalLoginPolicyError> {
    if !enabled {
        return Err(LocalLoginPolicyError::Disabled);
    }
    let email = command.email.trim().to_lowercase();
    if email.is_empty() || command.password.is_empty() {
        return Err(LocalLoginPolicyError::MissingCredentials);
    }
    Ok(ValidatedLocalLogin {
        email,
        password: command.password,
    })
}

#[cfg(test)]
mod tests {
    use super::{validate, LocalLoginCommand, LocalLoginPolicyError};

    #[test]
    fn policy_normalizes_email_and_checks_the_feature_switch() {
        assert_eq!(
            validate(
                false,
                LocalLoginCommand {
                    email: "user@example.com".to_string(),
                    password: "password".to_string(),
                },
            )
            .map(|login| login.email),
            Err(LocalLoginPolicyError::Disabled)
        );
        assert_eq!(
            validate(
                true,
                LocalLoginCommand {
                    email: "  USER@Example.com ".to_string(),
                    password: "password".to_string(),
                },
            )
            .map(|login| login.email),
            Ok("user@example.com".to_string())
        );
    }
}

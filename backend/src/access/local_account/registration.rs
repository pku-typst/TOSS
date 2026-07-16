//! Local account registration workflow and policy.

use super::super::account_policy::{
    bootstrap_admin_email_matches, is_valid_email, is_valid_username, normalize_username,
};
use super::super::organization::grant_site_admin_membership;
use super::{password, persistence};
use crate::database_error::is_unique_constraint_violation;
use chrono::Utc;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub(super) enum LocalRegistrationPolicyError {
    #[error("local account registration is disabled")]
    Disabled,
    #[error("email is required")]
    EmailRequired,
    #[error("email format is invalid")]
    InvalidEmail,
    #[error("username is required")]
    UsernameRequired,
    #[error("username format is invalid")]
    InvalidUsername,
    #[error("password is required")]
    PasswordRequired,
    #[error("password is too short")]
    PasswordTooShort,
}

#[derive(Debug, Error)]
pub(super) enum RegisterLocalAccountError {
    #[error(transparent)]
    Policy(#[from] LocalRegistrationPolicyError),
    #[error("password hashing failed")]
    PasswordHash(#[source] password::PasswordHashError),
    #[error("an account with this email already exists")]
    EmailConflict,
    #[error("this username is already taken")]
    UsernameConflict,
    #[error(transparent)]
    Persistence(#[from] PersistLocalAccountError),
}

#[derive(Clone, Copy, Debug)]
enum PersistLocalAccountStage {
    Begin,
    InsertUser,
    InsertCredentials,
    GrantBootstrapAdministrator,
    Commit,
}

#[derive(Debug, Error)]
#[error("local account persistence failed during {stage:?} for user {user_id}")]
pub(super) struct PersistLocalAccountError {
    stage: PersistLocalAccountStage,
    user_id: Uuid,
    #[source]
    source: sqlx::Error,
}

pub(super) struct LocalRegistrationCommand {
    pub email: String,
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
}

struct ValidatedLocalRegistration {
    email: String,
    username: String,
    password: String,
    display_name: String,
}

struct PreparedLocalRegistration {
    email: String,
    username: String,
    display_name: String,
    password_hash: String,
    bootstrap_admin: bool,
}

pub(super) struct RegisteredLocalAccount {
    pub user_id: Uuid,
    pub email: String,
    pub username: String,
}

pub(super) async fn register(
    db: &PgPool,
    enabled: bool,
    command: LocalRegistrationCommand,
) -> Result<RegisteredLocalAccount, RegisterLocalAccountError> {
    let registration = validate(enabled, command)?;
    let password_hash = password::hash(registration.password)
        .await
        .map_err(RegisterLocalAccountError::PasswordHash)?;
    let prepared = PreparedLocalRegistration {
        bootstrap_admin: bootstrap_admin_email_matches(&registration.email),
        email: registration.email,
        username: registration.username,
        display_name: registration.display_name,
        password_hash,
    };
    persist(db, prepared).await
}

fn validate(
    enabled: bool,
    command: LocalRegistrationCommand,
) -> Result<ValidatedLocalRegistration, LocalRegistrationPolicyError> {
    if !enabled {
        return Err(LocalRegistrationPolicyError::Disabled);
    }
    let email = command.email.trim().to_lowercase();
    if email.is_empty() {
        return Err(LocalRegistrationPolicyError::EmailRequired);
    }
    if !is_valid_email(&email) {
        return Err(LocalRegistrationPolicyError::InvalidEmail);
    }
    let username = normalize_username(&command.username);
    if username.is_empty() {
        return Err(LocalRegistrationPolicyError::UsernameRequired);
    }
    if !is_valid_username(&username) {
        return Err(LocalRegistrationPolicyError::InvalidUsername);
    }
    if command.password.is_empty() {
        return Err(LocalRegistrationPolicyError::PasswordRequired);
    }
    if command.password.len() < 8 {
        return Err(LocalRegistrationPolicyError::PasswordTooShort);
    }
    let display_name = command
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| email.split('@').next().unwrap_or("user").to_string());
    Ok(ValidatedLocalRegistration {
        email,
        username,
        password: command.password,
        display_name,
    })
}

async fn persist(
    db: &PgPool,
    registration: PreparedLocalRegistration,
) -> Result<RegisteredLocalAccount, RegisterLocalAccountError> {
    let user_id = Uuid::new_v4();
    let now = Utc::now();
    let record = persistence::InsertLocalAccountRecord {
        user_id,
        email: &registration.email,
        username: &registration.username,
        display_name: &registration.display_name,
        password_hash: &registration.password_hash,
        now,
    };
    let mut transaction = db
        .begin()
        .await
        .map_err(|source| PersistLocalAccountError {
            stage: PersistLocalAccountStage::Begin,
            user_id,
            source,
        })?;
    if let Err(database_error) = persistence::insert_user(&mut transaction, &record).await {
        if is_unique_constraint_violation(&database_error, "users_email_key") {
            return Err(RegisterLocalAccountError::EmailConflict);
        }
        if is_unique_constraint_violation(&database_error, "users_username_key") {
            return Err(RegisterLocalAccountError::UsernameConflict);
        }
        return Err(PersistLocalAccountError {
            stage: PersistLocalAccountStage::InsertUser,
            user_id,
            source: database_error,
        }
        .into());
    }
    persistence::insert_local_account(&mut transaction, &record)
        .await
        .map_err(|source| PersistLocalAccountError {
            stage: PersistLocalAccountStage::InsertCredentials,
            user_id,
            source,
        })?;
    if registration.bootstrap_admin {
        grant_site_admin_membership(&mut transaction, user_id, now)
            .await
            .map_err(|source| PersistLocalAccountError {
                stage: PersistLocalAccountStage::GrantBootstrapAdministrator,
                user_id,
                source,
            })?;
    }
    transaction
        .commit()
        .await
        .map_err(|source| PersistLocalAccountError {
            stage: PersistLocalAccountStage::Commit,
            user_id,
            source,
        })?;
    Ok(RegisteredLocalAccount {
        user_id,
        email: registration.email,
        username: registration.username,
    })
}

#[cfg(test)]
mod tests {
    use super::{validate, LocalRegistrationCommand, LocalRegistrationPolicyError};

    #[test]
    fn policy_normalizes_identity_and_validates_password() {
        let registration = validate(
            true,
            LocalRegistrationCommand {
                email: "  USER@Example.com ".to_string(),
                username: "  Alice-01  ".to_string(),
                password: "password".to_string(),
                display_name: None,
            },
        )
        .map(|registration| {
            (
                registration.email,
                registration.username,
                registration.display_name,
            )
        });
        assert_eq!(
            registration,
            Ok((
                "user@example.com".to_string(),
                "alice-01".to_string(),
                "user".to_string(),
            ))
        );
        assert_eq!(
            validate(
                true,
                LocalRegistrationCommand {
                    email: "user@example.com".to_string(),
                    username: "alice-01".to_string(),
                    password: "short".to_string(),
                    display_name: None,
                },
            )
            .map(|registration| registration.email),
            Err(LocalRegistrationPolicyError::PasswordTooShort)
        );
    }
}

//! Narrow PostgreSQL error classification shared by context persistence adapters.

pub(crate) fn is_unique_constraint_violation(error: &sqlx::Error, constraint: &str) -> bool {
    let Some(database_error) = error.as_database_error() else {
        return false;
    };
    database_error.code().as_deref() == Some("23505")
        && database_error.constraint() == Some(constraint)
}

//! Local account login, registration, password handling, and persistence.

mod authentication;
mod http;
mod password;
mod persistence;
mod registration;

pub(crate) use http::{local_login, local_register, LocalLoginInput, LocalRegisterInput};

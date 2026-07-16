use rand::distr::{Alphanumeric, SampleString};
use std::env;

pub(crate) fn is_valid_email(email: &str) -> bool {
    let bytes = email.as_bytes();
    if email.len() < 3 || email.len() > 254 {
        return false;
    }
    let Some(at_index) = bytes.iter().position(|byte| *byte == b'@') else {
        return false;
    };
    if at_index == 0 || at_index + 1 >= bytes.len() {
        return false;
    }
    let Some(domain) = email.get(at_index + 1..) else {
        return false;
    };
    domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

pub(crate) fn normalize_username(input: &str) -> String {
    input.trim().to_ascii_lowercase()
}

pub(crate) fn is_valid_username(username: &str) -> bool {
    let bytes = username.as_bytes();
    if bytes.len() < 2 || bytes.len() > 64 {
        return false;
    }
    let (Some(first), Some(last)) = (bytes.first(), bytes.last()) else {
        return false;
    };
    if !first.is_ascii_alphanumeric() || !last.is_ascii_alphanumeric() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b'-'))
}

pub(crate) fn sanitize_username_seed(input: &str) -> String {
    let mut raw = String::with_capacity(input.len());
    for character in input.chars() {
        if character.is_ascii_alphanumeric() {
            raw.push(character.to_ascii_lowercase());
        } else if matches!(character, '.' | '_' | '-') {
            raw.push(character);
        } else {
            raw.push('-');
        }
    }

    let mut collapsed = String::with_capacity(raw.len());
    let mut previous_was_separator = false;
    for character in raw.chars() {
        let is_separator = matches!(character, '.' | '_' | '-');
        if is_separator && (collapsed.is_empty() || previous_was_separator) {
            continue;
        }
        collapsed.push(character);
        previous_was_separator = is_separator;
    }

    while collapsed
        .chars()
        .next()
        .is_some_and(|character| !character.is_ascii_alphanumeric())
    {
        collapsed.remove(0);
    }
    while collapsed
        .chars()
        .last()
        .is_some_and(|character| !character.is_ascii_alphanumeric())
    {
        collapsed.pop();
    }

    if collapsed.is_empty() {
        collapsed.push_str("user");
    }
    while collapsed.len() < 2 {
        collapsed.push('x');
    }
    if collapsed.len() > 64 {
        collapsed.truncate(64);
        while collapsed
            .chars()
            .last()
            .is_some_and(|character| !character.is_ascii_alphanumeric())
        {
            collapsed.pop();
        }
    }
    while collapsed.len() < 2 {
        collapsed.push('x');
    }
    if is_valid_username(&collapsed) {
        collapsed
    } else {
        "userxxx".to_string()
    }
}

pub(crate) fn federated_username_candidate(base: &str, attempt: usize) -> String {
    if attempt == 0 {
        return base.to_string();
    }
    let suffix = Alphanumeric
        .sample_string(&mut rand::rng(), 5)
        .to_ascii_lowercase();
    let max_base_len = 64usize.saturating_sub(1 + suffix.len());
    let trimmed = if base.len() > max_base_len {
        base.get(..max_base_len).unwrap_or(base)
    } else {
        base
    };
    let candidate = format!("{trimmed}-{suffix}");
    if is_valid_username(&candidate) {
        candidate
    } else {
        "userxxx".to_string()
    }
}

pub(crate) fn bootstrap_admin_email_matches(email: &str) -> bool {
    env::var("BOOTSTRAP_ADMIN_EMAILS")
        .ok()
        .is_some_and(|configured| email_list_contains(&configured, email))
}

fn email_list_contains(configured: &str, email: &str) -> bool {
    configured
        .split(',')
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .any(|candidate| candidate.eq_ignore_ascii_case(email.trim()))
}

#[cfg(test)]
mod tests {
    use super::{email_list_contains, is_valid_email, is_valid_username};

    #[test]
    fn account_identifier_validation_handles_short_and_unicode_input() {
        assert!(!is_valid_email(""));
        assert!(!is_valid_email("é"));
        assert!(!is_valid_username(""));
        assert!(!is_valid_username("a"));
        assert!(!is_valid_username("éé"));
        assert!(is_valid_username("ab"));
        assert!(is_valid_email("alice@example.com"));
        assert!(is_valid_username("alice-01"));
        assert!(is_valid_username(&"a".repeat(64)));
        assert!(!is_valid_username(&"a".repeat(65)));
    }

    #[test]
    fn bootstrap_admin_email_matching_is_case_insensitive() {
        assert!(email_list_contains(
            "owner@example.com, admin@example.com",
            "ADMIN@EXAMPLE.COM"
        ));
        assert!(!email_list_contains(
            "owner@example.com, admin@example.com",
            "user@example.com"
        ));
    }
}

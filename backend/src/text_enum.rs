//! Shared implementation macro for canonical text-backed value enums.

macro_rules! text_enum {
    (
        $(#[$meta:meta])*
        pub enum $name:ident {
            $($variant:ident => $value:literal),+ $(,)?
        }
    ) => {
        #[derive(
            Debug,
            Clone,
            Copy,
            serde::Serialize,
            serde::Deserialize,
            PartialEq,
            Eq,
            sqlx::Type,
            utoipa::ToSchema,
        )]
        $(#[$meta])*
        #[sqlx(type_name = "text")]
        pub enum $name {
            $(#[serde(rename = $value)] #[sqlx(rename = $value)] #[schema(rename = $value)] $variant),+
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                match self {
                    $(Self::$variant => $value),+
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(self.as_ref())
            }
        }

        impl std::str::FromStr for $name {
            type Err = ();

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok(Self::$variant)),+,
                    _ => Err(()),
                }
            }
        }
    };
}

pub(crate) use text_enum;

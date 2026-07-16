//! Optional browser LaTeX runtime and on-demand TeXLive asset resolution.

mod cache;
mod config;
mod http;
mod request;
mod resolution;
mod singleflight;
mod upstream;

pub(crate) use http::latex_texlive_proxy;

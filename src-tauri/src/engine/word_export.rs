//! Markdown → Word (.docx) export via Quilldown.
//!
//! Quilldown resolves local image URLs with `base.join(url)` and has no containment check, so
//! every image reference is validated against the project root *before* conversion. The parse
//! here uses the same comrak options Quilldown uses, so both see the same image nodes.

use std::path::Path;

use comrak::{nodes::NodeValue, parse_document, Arena, Options};
use quilldown::{ConvertOptions, Converter, Orientation};
use serde::{Deserialize, Serialize};

use crate::engine::project;

const MIN_IMAGE_WIDTH_PX: u32 = 64;
const MAX_IMAGE_WIDTH_PX: u32 = 1_200;
const MAX_WARNING_CHARS: usize = 240;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WordOrientation {
    Portrait,
    Landscape,
}

/// Summary returned to the frontend after a successful export.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordExportReport {
    pub images_embedded: usize,
    /// Remote images are never fetched; they render as placeholder text.
    pub skipped_remote_images: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum WordExportError {
    #[error("Image '{0}' must be a path inside the project")]
    UnsafeImagePath(String),
    #[error("Image '{0}' uses an unsupported URL scheme")]
    UnsupportedImageUrl(String),
    #[error("Image '{url}' was not found at {path}")]
    MissingImage { url: String, path: String },
    #[error("Could not embed {count} image(s): {details}")]
    EmbedFailed { count: usize, details: String },
    #[error("Word conversion failed: {0}")]
    Convert(#[from] quilldown::ConvertError),
}

#[derive(Debug, PartialEq, Eq)]
enum ImageRef {
    Inline,
    Remote(String),
    Local,
}

/// Mirrors Quilldown's private `comrak_options_pub` so validation sees the same image nodes.
fn comrak_options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.tasklist = true;
    o.extension.autolink = true;
    o.extension.footnotes = true;
    o.extension.superscript = true;
    o.extension.subscript = true;
    o.extension.alerts = true;
    o.extension.math_dollars = true;
    o.extension.math_code = true;
    o.extension.front_matter_delimiter = Some("---".to_string());
    o
}

fn image_urls(markdown: &str) -> Vec<String> {
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &comrak_options());
    root.descendants()
        .filter_map(|node| match &node.data.borrow().value {
            NodeValue::Image(link) => Some(link.url.clone()),
            _ => None,
        })
        .collect()
}

fn has_url_scheme(url: &str) -> bool {
    let Some((scheme, _)) = url.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Classify an image URL exactly as Quilldown's loader will (its prefix checks are
/// case-sensitive), rejecting anything that would read outside the project.
fn classify_image(root: &Path, url: &str) -> Result<ImageRef, WordExportError> {
    if url.starts_with("data:") {
        return Ok(ImageRef::Inline);
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(ImageRef::Remote(url.to_string()));
    }
    if Path::new(url).is_absolute() {
        return Err(WordExportError::UnsafeImagePath(url.to_string()));
    }
    if has_url_scheme(url) {
        return Err(WordExportError::UnsupportedImageUrl(url.to_string()));
    }
    let resolved = project::safe_resolve(root, url)
        .map_err(|_| WordExportError::UnsafeImagePath(url.to_string()))?;
    if !resolved.is_file() {
        return Err(WordExportError::MissingImage {
            url: url.to_string(),
            path: resolved.display().to_string(),
        });
    }
    Ok(ImageRef::Local)
}

fn truncate_warning(warning: &str) -> String {
    if warning.chars().count() <= MAX_WARNING_CHARS {
        return warning.to_string();
    }
    let head: String = warning.chars().take(MAX_WARNING_CHARS).collect();
    format!("{head}…")
}

/// Render project markdown to `.docx` bytes. Local images must resolve inside `root`.
pub fn render_markdown_to_docx(
    root: &Path,
    markdown: &str,
    orientation: WordOrientation,
    max_image_width_px: u32,
) -> Result<(Vec<u8>, WordExportReport), WordExportError> {
    let mut remote = Vec::new();
    for url in image_urls(markdown) {
        if let ImageRef::Remote(url) = classify_image(root, &url)? {
            remote.push(url);
        }
    }

    let opts = ConvertOptions {
        base_dir: Some(root.to_path_buf()),
        allow_remote_images: false,
        // Keep project SVGs as authored; CutReady visuals arrive pre-rendered in light mode.
        svg_light_mode: false,
        max_image_width_px: max_image_width_px.clamp(MIN_IMAGE_WIDTH_PX, MAX_IMAGE_WIDTH_PX),
        page: quilldown::PageSetup {
            orientation: match orientation {
                WordOrientation::Portrait => Orientation::Portrait,
                WordOrientation::Landscape => Orientation::Landscape,
            },
            ..Default::default()
        },
        ..Default::default()
    };
    let (bytes, stats) = Converter::new(opts).convert_to_bytes(markdown, root)?;

    // Remote images always fail (fetching is off). Count only those Quilldown actually
    // rendered, so unrendered remote refs (e.g. unused footnotes) cannot mask local losses.
    let failed_remote = |w: &str| {
        remote
            .iter()
            .find(|r| w.starts_with(&format!("could not embed image '{r}': ")))
            .cloned()
    };
    let mut skipped_remote = Vec::new();
    let mut local_warnings = Vec::new();
    for warning in &stats.warnings {
        match failed_remote(warning) {
            Some(url) => skipped_remote.push(url),
            None => local_warnings.push(truncate_warning(warning)),
        }
    }
    let local_failures = stats.images_failed.saturating_sub(skipped_remote.len());
    if local_failures > 0 {
        return Err(WordExportError::EmbedFailed {
            count: local_failures,
            details: local_warnings.join("; "),
        });
    }

    let mut seen = std::collections::HashSet::new();
    skipped_remote.retain(|url| seen.insert(url.clone()));
    Ok((
        bytes,
        WordExportReport {
            images_embedded: stats.images_embedded,
            skipped_remote_images: skipped_remote,
        },
    ))
}

/// Render and write a `.docx` file chosen by the user.
pub fn export_markdown_to_word(
    root: &Path,
    markdown: &str,
    output_path: &Path,
    orientation: WordOrientation,
    max_image_width_px: u32,
) -> Result<WordExportReport, String> {
    let is_docx = output_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("docx"));
    if !output_path.is_absolute() || !is_docx {
        return Err(format!(
            "Word export path must be an absolute .docx path: {}",
            output_path.display()
        ));
    }
    let (bytes, report) =
        render_markdown_to_docx(root, markdown, orientation, max_image_width_px)
            .map_err(|e| e.to_string())?;
    std::fs::write(output_path, bytes)
        .map_err(|e| format!("Could not write {}: {e}", output_path.display()))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn png_bytes() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(4, 3, image::Rgba([200, 30, 30, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn project_with_screenshot(name: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let shots = dir.path().join(".cutready").join("screenshots");
        std::fs::create_dir_all(&shots).unwrap();
        std::fs::write(shots.join(name), png_bytes()).unwrap();
        dir
    }

    fn zip_entries(bytes: &[u8]) -> Vec<String> {
        let archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        archive.file_names().map(str::to_string).collect()
    }

    fn document_xml(bytes: &[u8]) -> String {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        xml
    }

    fn media_count(bytes: &[u8]) -> usize {
        zip_entries(bytes)
            .iter()
            .filter(|n| n.starts_with("word/media/"))
            .count()
    }

    #[test]
    fn embeds_project_screenshot_with_spaces_in_table_cell() {
        let dir = project_with_screenshot("my shot.png");
        let md = "| Time | Shot |\n| --- | --- |\n| 0:05 | ![Login screen](<.cutready/screenshots/my shot.png>) |\n";
        let (bytes, report) =
            render_markdown_to_docx(dir.path(), md, WordOrientation::Landscape, 220).unwrap();
        assert_eq!(report.images_embedded, 1);
        assert_eq!(media_count(&bytes), 1);
        let xml = document_xml(&bytes);
        assert!(xml.contains("<w:tbl>"), "table should be native");
        assert!(xml.contains("Login screen"), "alt text should be recorded");
    }

    #[test]
    fn rejects_traversal_and_absolute_images_before_reading() {
        let dir = project_with_screenshot("a.png");
        let outside = dir.path().join("..").join("secret.png");
        for url in [
            "../secret.png".to_string(),
            ".cutready/../../secret.png".to_string(),
            outside.display().to_string(),
        ] {
            let md = format!("![x](<{url}>)");
            let err = render_markdown_to_docx(dir.path(), &md, WordOrientation::Portrait, 600)
                .unwrap_err();
            assert!(
                matches!(err, WordExportError::UnsafeImagePath(_)),
                "{url}: {err}"
            );
        }
    }

    #[test]
    fn rejects_non_http_schemes() {
        let dir = project_with_screenshot("a.png");
        let err = render_markdown_to_docx(
            dir.path(),
            "![x](file:secret.png)",
            WordOrientation::Portrait,
            600,
        )
        .unwrap_err();
        assert!(matches!(err, WordExportError::UnsupportedImageUrl(_)), "{err}");
    }

    #[test]
    fn missing_project_image_fails_export() {
        let dir = project_with_screenshot("a.png");
        let err = render_markdown_to_docx(
            dir.path(),
            "![x](.cutready/screenshots/missing.png)",
            WordOrientation::Portrait,
            600,
        )
        .unwrap_err();
        assert!(matches!(err, WordExportError::MissingImage { .. }), "{err}");
    }

    #[test]
    fn corrupt_project_image_fails_export() {
        let dir = project_with_screenshot("a.png");
        std::fs::write(
            dir.path().join(".cutready/screenshots/bad.png"),
            b"not an image",
        )
        .unwrap();
        let err = render_markdown_to_docx(
            dir.path(),
            "![x](.cutready/screenshots/bad.png)",
            WordOrientation::Portrait,
            600,
        )
        .unwrap_err();
        assert!(matches!(err, WordExportError::EmbedFailed { count: 1, .. }), "{err}");
    }

    #[test]
    fn embeds_data_url_images_offline() {
        use base64::Engine as _;
        let dir = tempfile::tempdir().unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode(png_bytes());
        let md = format!("![Visual](data:image/png;base64,{data})");
        let (bytes, report) =
            render_markdown_to_docx(dir.path(), &md, WordOrientation::Portrait, 600).unwrap();
        assert_eq!(report.images_embedded, 1);
        assert_eq!(media_count(&bytes), 1);
    }

    #[test]
    fn remote_images_are_skipped_not_fetched() {
        let dir = tempfile::tempdir().unwrap();
        let md = "![a](https://example.invalid/a.png)\n\n![b](https://example.invalid/a.png)";
        let (bytes, report) =
            render_markdown_to_docx(dir.path(), md, WordOrientation::Portrait, 600).unwrap();
        assert_eq!(report.images_embedded, 0);
        assert_eq!(
            report.skipped_remote_images,
            vec!["https://example.invalid/a.png".to_string()]
        );
        assert_eq!(media_count(&bytes), 0);
    }

    #[test]
    fn unrendered_remote_refs_cannot_mask_local_failures() {
        let dir = project_with_screenshot("a.png");
        std::fs::write(
            dir.path().join(".cutready/screenshots/bad.png"),
            b"not an image",
        )
        .unwrap();
        let md = "![x](.cutready/screenshots/bad.png)\n\n[^unused]: ![r](https://example.invalid/r.png)\n";
        let err = render_markdown_to_docx(dir.path(), md, WordOrientation::Portrait, 600)
            .unwrap_err();
        assert!(matches!(err, WordExportError::EmbedFailed { count: 1, .. }), "{err}");
    }

    #[test]
    fn landscape_swaps_page_geometry() {
        let dir = tempfile::tempdir().unwrap();
        let (portrait, _) =
            render_markdown_to_docx(dir.path(), "# Hi", WordOrientation::Portrait, 600).unwrap();
        let (landscape, _) =
            render_markdown_to_docx(dir.path(), "# Hi", WordOrientation::Landscape, 600).unwrap();
        assert!(document_xml(&portrait).contains("w:w=\"12240\""));
        let xml = document_xml(&landscape);
        assert!(xml.contains("w:w=\"15840\""), "landscape width: {xml}");
    }

    #[test]
    fn write_requires_absolute_docx_path() {
        let dir = tempfile::tempdir().unwrap();
        let err = export_markdown_to_word(
            dir.path(),
            "# Hi",
            Path::new("relative.docx"),
            WordOrientation::Portrait,
            600,
        )
        .unwrap_err();
        assert!(err.contains("absolute .docx"));
        let err = export_markdown_to_word(
            dir.path(),
            "# Hi",
            &dir.path().join("out.txt"),
            WordOrientation::Portrait,
            600,
        )
        .unwrap_err();
        assert!(err.contains("absolute .docx"));

        let out = dir.path().join("out.docx");
        export_markdown_to_word(dir.path(), "# Hi", &out, WordOrientation::Portrait, 600)
            .unwrap();
        assert!(out.is_file());
    }
}

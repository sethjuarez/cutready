//! Document import: .docx → markdown, .pdf → markdown, .pptx → sketch rows.
//! Extracts embedded images and saves them to .cutready/screenshots/.

use std::io::{Cursor, Read};
use std::path::Path;

/// Ensure the screenshots directory exists and return its path.
fn screenshots_dir(project_root: &Path) -> Result<std::path::PathBuf, String> {
    let dir = project_root.join(".cutready").join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create screenshots dir: {e}"))?;
    Ok(dir)
}

/// Save raw image bytes to .cutready/screenshots/ with a unique name.
fn save_image(project_root: &Path, prefix: &str, index: usize, data: &[u8], ext: &str) -> Result<String, String> {
    let dir = screenshots_dir(project_root)?;
    let filename = format!("{prefix}-{index}.{ext}");
    let abs_path = dir.join(&filename);
    std::fs::write(&abs_path, data).map_err(|e| format!("Failed to write image: {e}"))?;
    Ok(format!(".cutready/screenshots/{filename}"))
}

/// Guess image extension from zip entry name.
fn image_ext(name: &str) -> &str {
    if name.ends_with(".png") { "png" }
    else if name.ends_with(".gif") { "gif" }
    else if name.ends_with(".bmp") { "bmp" }
    else if name.ends_with(".svg") { "svg" }
    else { "jpg" }
}

/// Extract text and images from a .docx file and return markdown.
/// Images are saved to project_root/.cutready/screenshots/.
pub fn docx_to_markdown(data: &[u8], project_root: &Path) -> Result<String, String> {
    let cursor = Cursor::new(data);
    let mut archive = match zip::ZipArchive::new(cursor) {
        Ok(a) => a,
        Err(_) => {
            // Not a ZIP — likely an old .doc binary format. Extract readable text.
            return doc_binary_to_markdown(data);
        }
    };

    let prefix = format!("docx-{}", chrono::Utc::now().format("%Y%m%d%H%M%S"));

    // Extract images from word/media/
    let mut image_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let media_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with("word/media/"))
        .collect();

    for (idx, media_name) in media_names.iter().enumerate() {
        let mut img_data = Vec::new();
        if let Ok(mut file) = archive.by_name(media_name) {
            let _ = file.read_to_end(&mut img_data);
        }
        if !img_data.is_empty() {
            let ext = image_ext(media_name);
            if let Ok(rel_path) = save_image(project_root, &prefix, idx, &img_data, ext) {
                let basename = media_name.rsplit('/').next().unwrap_or(media_name);
                image_map.insert(basename.to_string(), rel_path);
            }
        }
    }

    // Parse document.xml.rels to map rId → media filename
    let mut rid_to_media: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(rels_xml) = read_zip_text(&mut archive, "word/_rels/document.xml.rels") {
        parse_rels_for_media(&rels_xml, &mut rid_to_media);
    }

    // Parse document.xml
    let mut xml = String::new();
    {
        let mut file = archive
            .by_name("word/document.xml")
            .map_err(|e| format!("Missing word/document.xml: {e}"))?;
        file.read_to_string(&mut xml)
            .map_err(|e| format!("Read error: {e}"))?;
    }

    let mut md = String::new();
    let mut reader = quick_xml::Reader::from_str(&xml);
    let mut in_paragraph = false;
    let mut paragraph_text = String::new();
    let mut in_t = false;
    let mut heading_level: Option<u8> = None;
    let mut pending_image_rid: Option<String> = None;

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(ref e)) => {
                match e.name().as_ref() {
                    b"w:p" => {
                        in_paragraph = true;
                        paragraph_text.clear();
                        heading_level = None;
                    }
                    b"w:pStyle" if in_paragraph => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"w:val" {
                                let val = String::from_utf8_lossy(&attr.value);
                                if val.starts_with("Heading") || val.starts_with("heading") {
                                    let level = val.chars().filter(|c| c.is_ascii_digit())
                                        .collect::<String>().parse::<u8>().unwrap_or(1);
                                    heading_level = Some(level.min(6));
                                }
                            }
                        }
                    }
                    b"w:t" => { in_t = true; }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::Empty(ref e)) => {
                // <a:blip r:embed="rId5"/> — image reference
                if e.name().as_ref() == b"a:blip" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"r:embed" {
                            pending_image_rid = Some(String::from_utf8_lossy(&attr.value).to_string());
                        }
                    }
                }
            }
            Ok(quick_xml::events::Event::End(ref e)) => {
                match e.name().as_ref() {
                    b"w:p" => {
                        if in_paragraph {
                            if let Some(rid) = pending_image_rid.take() {
                                if let Some(media_name) = rid_to_media.get(&rid) {
                                    if let Some(rel_path) = image_map.get(media_name) {
                                        md.push_str(&format!("![{media_name}]({rel_path})\n\n"));
                                    }
                                }
                            }
                            let trimmed = paragraph_text.trim();
                            if !trimmed.is_empty() {
                                if let Some(level) = heading_level {
                                    let hashes = "#".repeat(level as usize);
                                    md.push_str(&format!("{hashes} {trimmed}\n\n"));
                                } else {
                                    md.push_str(trimmed);
                                    md.push_str("\n\n");
                                }
                            }
                            in_paragraph = false;
                        }
                    }
                    b"w:t" => { in_t = false; }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::Text(ref e)) => {
                if in_t && in_paragraph {
                    let text = e.unescape().unwrap_or_default();
                    paragraph_text.push_str(&text);
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(format!("XML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(md.trim().to_string())
}

/// Extract text from a PDF file and return it as markdown.
pub fn pdf_to_markdown(data: &[u8]) -> Result<String, String> {
    let text = pdf_extract::extract_text_from_mem(data)
        .map_err(|e| format!("PDF extraction error: {e}"))?;

    let mut md = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !md.ends_with("\n\n") {
                md.push('\n');
            }
        } else {
            if !md.is_empty() && !md.ends_with('\n') {
                md.push(' ');
            }
            md.push_str(trimmed);
            md.push('\n');
        }
    }

    Ok(md.trim().to_string())
}

/// Extract slides from a .pptx file as markdown.
/// Each slide becomes a section with its content, speaker notes, and images.
pub fn pptx_to_markdown(data: &[u8], project_root: &Path) -> Result<String, String> {
    let cursor = Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid .pptx: {e}"))?;

    let prefix = format!("pptx-{}", chrono::Utc::now().format("%Y%m%d%H%M%S"));

    // Pre-extract all media files from ppt/media/
    let media_entries: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with("ppt/media/"))
        .collect();

    let mut media_data: std::collections::HashMap<String, Vec<u8>> = std::collections::HashMap::new();
    for name in &media_entries {
        let mut buf = Vec::new();
        if let Ok(mut f) = archive.by_name(name) {
            let _ = f.read_to_end(&mut buf);
        }
        if !buf.is_empty() {
            let basename = name.rsplit('/').next().unwrap_or(name).to_string();
            media_data.insert(basename, buf);
        }
    }

    // Find all slide XMLs
    let mut slide_names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if let Ok(file) = archive.by_index(i) {
            let name = file.name().to_string();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                slide_names.push(name);
            }
        }
    }
    slide_names.sort_by_key(|name| {
        name.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0)
    });

    let mut md = String::new();
    let mut img_counter = 0usize;

    for (idx, slide_name) in slide_names.iter().enumerate() {
        let slide_text = read_zip_text(&mut archive, slide_name)?;
        let body_text = extract_pptx_text(&slide_text);

        // Read slide relationships to find images
        let slide_num = slide_name.trim_start_matches("ppt/slides/slide").trim_end_matches(".xml");
        let rels_name = format!("ppt/slides/_rels/slide{slide_num}.xml.rels");
        let image_path = if let Ok(rels_xml) = read_zip_text(&mut archive, &rels_name) {
            find_first_image_from_rels(&rels_xml, &media_data, project_root, &prefix, &mut img_counter)
        } else {
            None
        };

        // Speaker notes
        let notes_name = format!("ppt/notesSlides/notesSlide{}.xml", idx + 1);
        let notes_text = read_zip_text(&mut archive, &notes_name)
            .ok()
            .map(|xml| extract_pptx_text(&xml))
            .unwrap_or_default();

        let body = body_text.trim();
        let notes = notes_text.trim();

        if body.is_empty() && notes.is_empty() && image_path.is_none() {
            continue;
        }

        // Use first line of first slide as title, rest as ## Slide N
        if idx == 0 {
            if let Some(first_line) = body.lines().next() {
                md.push_str(&format!("# {}\n\n", first_line.trim()));
                // Rest of body after the title line
                let rest: String = body.lines().skip(1)
                    .map(|l| l.trim())
                    .filter(|l| !l.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !rest.is_empty() {
                    md.push_str(&rest);
                    md.push_str("\n\n");
                }
            }
        } else {
            // Use first line as slide heading
            if let Some(first_line) = body.lines().next() {
                md.push_str(&format!("## Slide {} — {}\n\n", idx + 1, first_line.trim()));
                let rest: String = body.lines().skip(1)
                    .map(|l| l.trim())
                    .filter(|l| !l.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !rest.is_empty() {
                    md.push_str(&rest);
                    md.push_str("\n\n");
                }
            } else {
                md.push_str(&format!("## Slide {}\n\n", idx + 1));
            }
        }

        if let Some(img) = image_path {
            md.push_str(&format!("![slide {}]({img})\n\n", idx + 1));
        }

        if !notes.is_empty() {
            md.push_str(&format!("**Speaker Notes:** {notes}\n\n"));
        }

        md.push_str("---\n\n");
    }

    Ok(md.trim().to_string())
}

// ── Helpers ──────────────────────────────────────────────────────

/// Parse a .rels XML to extract rId → media filename mappings.
fn parse_rels_for_media(rels_xml: &str, out: &mut std::collections::HashMap<String, String>) {
    let mut reader = quick_xml::Reader::from_str(rels_xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Empty(ref e)) | Ok(quick_xml::events::Event::Start(ref e))
                if e.name().as_ref() == b"Relationship" =>
            {
                let mut rid = String::new();
                let mut target = String::new();
                for attr in e.attributes().flatten() {
                    match attr.key.as_ref() {
                        b"Id" => rid = String::from_utf8_lossy(&attr.value).to_string(),
                        b"Target" => target = String::from_utf8_lossy(&attr.value).to_string(),
                        _ => {}
                    }
                }
                if target.contains("media/") {
                    let basename = target.rsplit('/').next().unwrap_or(&target).to_string();
                    out.insert(rid, basename);
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
}

/// Find the first image relationship in a .rels file, save it, return its relative path.
fn find_first_image_from_rels(
    rels_xml: &str,
    media_data: &std::collections::HashMap<String, Vec<u8>>,
    project_root: &Path,
    prefix: &str,
    counter: &mut usize,
) -> Option<String> {
    let mut reader = quick_xml::Reader::from_str(rels_xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Empty(ref e)) | Ok(quick_xml::events::Event::Start(ref e))
                if e.name().as_ref() == b"Relationship" =>
            {
                let mut rel_type = String::new();
                let mut target = String::new();
                for attr in e.attributes().flatten() {
                    match attr.key.as_ref() {
                        b"Type" => rel_type = String::from_utf8_lossy(&attr.value).to_string(),
                        b"Target" => target = String::from_utf8_lossy(&attr.value).to_string(),
                        _ => {}
                    }
                }
                if rel_type.contains("/image") {
                    let basename = target.rsplit('/').next().unwrap_or(&target).to_string();
                    if let Some(data) = media_data.get(&basename) {
                        let ext = image_ext(&basename);
                        if let Ok(path) = save_image(project_root, prefix, *counter, data, ext) {
                            *counter += 1;
                            return Some(path);
                        }
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

fn read_zip_text(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String, String> {
    let mut xml = String::new();
    let mut file = archive
        .by_name(name)
        .map_err(|e| format!("Missing {name}: {e}"))?;
    file.read_to_string(&mut xml)
        .map_err(|e| format!("Read error: {e}"))?;
    Ok(xml)
}

/// Extract text content from PowerPoint slide XML (<a:t> within <a:p>).
fn extract_pptx_text(xml: &str) -> String {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current_para = String::new();
    let mut in_t = false;
    let mut in_p = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(ref e)) => {
                match e.name().as_ref() {
                    b"a:p" => { in_p = true; current_para.clear(); }
                    b"a:t" => { in_t = true; }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::End(ref e)) => {
                match e.name().as_ref() {
                    b"a:p" => {
                        if in_p {
                            let trimmed = current_para.trim().to_string();
                            if !trimmed.is_empty() { paragraphs.push(trimmed); }
                            in_p = false;
                        }
                    }
                    b"a:t" => { in_t = false; }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::Text(ref e)) => {
                if in_t && in_p {
                    let text = e.unescape().unwrap_or_default();
                    current_para.push_str(&text);
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    paragraphs.join("\n")
}

/// Extract readable text from an old binary .doc file.
/// Uses a simple heuristic: find runs of printable characters, skipping binary junk.
fn doc_binary_to_markdown(data: &[u8]) -> Result<String, String> {
    // Old .doc files have a Compound File Binary Format (CFBF) header.
    // The actual text is stored as UTF-16LE (or sometimes ASCII) in the file stream.
    // We try UTF-16LE first (most common for .doc), then fall back to ASCII extraction.

    // Try UTF-16LE extraction: scan for runs of valid UTF-16LE pairs
    let mut utf16_text = String::new();
    if data.len() >= 2 {
        let mut i = 0;
        let mut current_run = Vec::new();
        while i + 1 < data.len() {
            let lo = data[i];
            let hi = data[i + 1];
            let ch = u16::from_le_bytes([lo, hi]);
            if let Some(c) = char::from_u32(ch as u32) {
                if c.is_ascii_graphic() || c == ' ' || c == '\n' || c == '\r' || c == '\t' {
                    current_run.push(c);
                } else if !current_run.is_empty() {
                    // End of a run — keep if substantial (>20 chars with spaces = likely real text)
                    let run: String = current_run.drain(..).collect();
                    if run.len() > 20 && run.contains(' ') {
                        utf16_text.push_str(run.trim());
                        utf16_text.push_str("\n\n");
                    }
                }
            } else if !current_run.is_empty() {
                let run: String = current_run.drain(..).collect();
                if run.len() > 20 && run.contains(' ') {
                    utf16_text.push_str(run.trim());
                    utf16_text.push_str("\n\n");
                }
            }
            i += 2;
        }
        // Flush remaining
        if !current_run.is_empty() {
            let run: String = current_run.drain(..).collect();
            if run.len() > 20 && run.contains(' ') {
                utf16_text.push_str(run.trim());
                utf16_text.push_str("\n\n");
            }
        }
    }

    let result = utf16_text.trim().to_string();
    if result.len() > 50 {
        return Ok(result);
    }

    // Fallback: ASCII extraction for very old files
    let mut ascii_text = String::new();
    let mut current_run = String::new();
    for &b in data {
        let c = b as char;
        if c.is_ascii_graphic() || c == ' ' || c == '\n' || c == '\r' || c == '\t' {
            current_run.push(c);
        } else if !current_run.is_empty() {
            let run = current_run.trim().to_string();
            if run.len() > 20 && run.contains(' ') {
                ascii_text.push_str(&run);
                ascii_text.push_str("\n\n");
            }
            current_run.clear();
        }
    }
    if !current_run.is_empty() {
        let run = current_run.trim().to_string();
        if run.len() > 20 && run.contains(' ') {
            ascii_text.push_str(&run);
        }
    }

    let result = ascii_text.trim().to_string();
    if result.is_empty() {
        Err("Could not extract text. The file may be an old .doc format — try saving it as .docx first.".to_string())
    } else {
        Ok(result)
    }
}

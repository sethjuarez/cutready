//! Document import: .docx → markdown, .pdf → markdown, .pptx → sketch rows.

use std::io::{Cursor, Read};

use crate::models::sketch::PlanningRow;

/// Extract plain text from a .docx file and return it as markdown.
pub fn docx_to_markdown(data: &[u8]) -> Result<String, String> {
    let cursor = Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid .docx: {e}"))?;

    let mut xml = String::new();
    {
        let mut file = archive
            .by_name("word/document.xml")
            .map_err(|e| format!("Missing word/document.xml: {e}"))?;
        file.read_to_string(&mut xml)
            .map_err(|e| format!("Read error: {e}"))?;
    }

    // Parse XML and extract text from <w:t> elements, using <w:p> as paragraph breaks
    let mut md = String::new();
    let reader = quick_xml::Reader::from_str(&xml);
    let mut in_paragraph = false;
    let mut paragraph_text = String::new();
    let mut in_t = false;
    let mut heading_level: Option<u8> = 0.into(); // None = no heading
    let mut in_style = false;

    let mut reader = reader;
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
                        // Check for heading style
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"w:val" {
                                let val = String::from_utf8_lossy(&attr.value);
                                if val.starts_with("Heading") || val.starts_with("heading") {
                                    let level = val
                                        .chars()
                                        .filter(|c| c.is_ascii_digit())
                                        .collect::<String>()
                                        .parse::<u8>()
                                        .unwrap_or(1);
                                    heading_level = Some(level.min(6));
                                }
                            }
                        }
                    }
                    b"w:rStyle" => {
                        in_style = true;
                    }
                    b"w:t" => {
                        in_t = true;
                    }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::End(ref e)) => {
                match e.name().as_ref() {
                    b"w:p" => {
                        if in_paragraph {
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
                    b"w:t" => {
                        in_t = false;
                    }
                    b"w:rStyle" => {
                        in_style = false;
                    }
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

    // Clean up: normalize whitespace, add paragraph breaks on double-newlines
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

/// Extract slides from a .pptx file as planning rows.
/// Each slide becomes a row: title/body → narrative, speaker notes → demo_actions.
pub fn pptx_to_planning_rows(data: &[u8]) -> Result<(String, Vec<PlanningRow>), String> {
    let cursor = Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid .pptx: {e}"))?;

    // Find all slide XML files (ppt/slides/slide1.xml, slide2.xml, ...)
    let mut slide_names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if let Ok(file) = archive.by_index(i) {
            let name = file.name().to_string();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                slide_names.push(name);
            }
        }
    }
    // Sort by slide number
    slide_names.sort_by_key(|name| {
        name.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(0)
    });

    // Try to get presentation title from first slide or use generic
    let mut presentation_title = String::new();
    let mut rows = Vec::new();

    for (idx, slide_name) in slide_names.iter().enumerate() {
        // Read slide XML
        let slide_text = read_zip_entry(&mut archive, slide_name)?;
        let body_text = extract_pptx_text(&slide_text);

        // Try to read corresponding notes (ppt/notesSlides/notesSlide{N}.xml)
        let slide_num = idx + 1;
        let notes_name = format!("ppt/notesSlides/notesSlide{slide_num}.xml");
        let notes_text = read_zip_entry(&mut archive, &notes_name)
            .ok()
            .map(|xml| extract_pptx_text(&xml))
            .unwrap_or_default();

        // First slide title becomes presentation title
        if idx == 0 && presentation_title.is_empty() {
            if let Some(first_line) = body_text.lines().next() {
                presentation_title = first_line.trim().to_string();
            }
        }

        let narrative = body_text.trim().to_string();
        let demo_actions = notes_text.trim().to_string();

        if !narrative.is_empty() || !demo_actions.is_empty() {
            rows.push(PlanningRow {
                time: format!("~{}s", 30 + idx * 10),
                narrative,
                demo_actions,
                screenshot: None,
            });
        }
    }

    if presentation_title.is_empty() {
        presentation_title = "Imported Presentation".to_string();
    }

    Ok((presentation_title, rows))
}

fn read_zip_entry(archive: &mut zip::ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<String, String> {
    let mut xml = String::new();
    let mut file = archive
        .by_name(name)
        .map_err(|e| format!("Missing {name}: {e}"))?;
    file.read_to_string(&mut xml)
        .map_err(|e| format!("Read error: {e}"))?;
    Ok(xml)
}

/// Extract text content from PowerPoint slide XML.
/// Looks for <a:t> elements within <p:sp> (shape) containers.
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
                    b"a:p" => {
                        in_p = true;
                        current_para.clear();
                    }
                    b"a:t" => {
                        in_t = true;
                    }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::End(ref e)) => {
                match e.name().as_ref() {
                    b"a:p" => {
                        if in_p {
                            let trimmed = current_para.trim().to_string();
                            if !trimmed.is_empty() {
                                paragraphs.push(trimmed);
                            }
                            in_p = false;
                        }
                    }
                    b"a:t" => {
                        in_t = false;
                    }
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

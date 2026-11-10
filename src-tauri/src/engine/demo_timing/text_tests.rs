use super::text::{classify_boundary, edit_distance, normalize_token, sub_tokens, BoundaryClass};

#[test]
fn normalize_token_table() {
    let cases: &[(&str, &str)] = &[
        ("Panel", "panel"),
        ("Panel,", "panel"),
        ("(Settings)", "settings"),
        ("\u{201C}Open\u{201D}", "open"),
        ("'quoted'", "quoted"),
        ("don\u{2019}t", "don't"),
        ("Don't.", "don't"),
        ("drag\u{2014}and", "drag-and"),
        ("drag\u{2011}and\u{2011}drop", "drag-and-drop"),
        ("\u{00C9}CLAIR!", "\u{00E9}clair"),
        ("Stra\u{00DF}e.", "stra\u{00DF}e"),
        (
            "\u{0391}\u{0398}\u{0397}\u{039D}\u{0391}",
            "\u{03B1}\u{03B8}\u{03B7}\u{03BD}\u{03B1}",
        ),
        ("cafe\u{0301}", "cafe\u{0301}"),
        ("3", "3"),
        ("3.", "3"),
        ("v2.0", "v2.0"),
        ("...", ""),
        ("\u{2014}", ""),
        ("", ""),
    ];
    for &(raw, expected) in cases {
        assert_eq!(normalize_token(raw), expected, "normalize {raw:?}");
    }
}

#[test]
fn sub_tokens_split_whitespace_and_hyphens() {
    let cases: &[(&str, &[&str])] = &[
        (
            "  Open the  Settings panel. ",
            &["open", "the", "settings", "panel"],
        ),
        ("drag-and-drop", &["drag", "and", "drop"]),
        ("drag\u{2013}and\u{2013}drop!", &["drag", "and", "drop"]),
        ("re-", &["re"]),
        ("- \u{2014} ...", &[]),
        ("\u{2018}Hello,\u{2019} world", &["hello", "world"]),
    ];
    for &(text, expected) in cases {
        assert_eq!(sub_tokens(text), expected, "sub_tokens {text:?}");
    }
}

#[test]
fn digits_are_not_number_words() {
    assert_ne!(sub_tokens("3"), sub_tokens("three"));
    assert_ne!(normalize_token("1st"), normalize_token("first"));
}

#[test]
fn edit_distance_table() {
    assert_eq!(edit_distance("kitten", "sitting"), 3);
    assert_eq!(edit_distance("panel", "pannel"), 1);
    assert_eq!(edit_distance("", "abc"), 3);
    assert_eq!(edit_distance("same", "same"), 0);
}

#[test]
fn boundary_classes() {
    let cases: &[(&str, BoundaryClass)] = &[
        (" ", BoundaryClass::Word),
        (", ", BoundaryClass::Clause),
        ("; ", BoundaryClass::Clause),
        (" \u{2014} ", BoundaryClass::Clause),
        (". ", BoundaryClass::Sentence),
        ("?\u{201D} ", BoundaryClass::Sentence),
        ("\u{2026} ", BoundaryClass::Sentence),
    ];
    for &(between, expected) in cases {
        assert_eq!(classify_boundary(between), expected, "{between:?}");
    }
}

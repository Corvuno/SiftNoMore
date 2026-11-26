//! Reading a file name the way a person does: what the thing is called, whether the name carries
//! a copy mark ("setup (1).exe", "report - Copy.pdf"), and which version it is ("vlc-3.0.20").
//! Everything fuzzy in duplicates and "newer version exists" rests on this.

use regex::Regex;
use std::sync::OnceLock;

/// How sure a copy mark is. A bracketed number or a copy word is almost always a copy; a bare
/// trailing number ("report 1") could just as well be part of the name ("Chapter 2").
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CopyMark {
    None,
    Weak,
    Strong,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NameParts {
    /// The extension in lower case, without the dot ("exe", "tar.gz"), or "" when there is none.
    pub ext: String,
    /// The name without extension and without copy marks, lower case, spaces tidied.
    pub base: String,
    pub mark: CopyMark,
    /// What the product is called once version, "setup" and platform words are taken out.
    /// Only set when a version was found: that is what makes two names "versions" of one thing.
    pub product: Option<String>,
    pub version: Option<Vec<u64>>,
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid pattern"))
}

/// Splits "a.b.tar.gz" into ("a.b", "tar.gz"). A leading dot (".gitignore") is not an extension.
pub fn split_ext(name: &str) -> (&str, String) {
    let lower = name.to_lowercase();
    for double in [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"] {
        if lower.ends_with(double) && lower.len() > double.len() {
            let cut = name.len() - double.len();
            return (&name[..cut], double[1..].to_string());
        }
    }
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => {
            let ext = &name[i + 1..];
            // "Some Doc v1.2" has no real extension "2"; extensions have a letter in them or are
            // short known numeric ones like "7z" or "mp3", so pure digits are not an extension.
            if ext.len() <= 8
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
                && ext.chars().any(|c| c.is_ascii_alphabetic())
            {
                (&name[..i], ext.to_lowercase())
            } else {
                (name, String::new())
            }
        }
        _ => (name, String::new()),
    }
}

fn tidy(s: &str) -> String {
    static WS: OnceLock<Regex> = OnceLock::new();
    re(&WS, r"\s+").replace_all(s.trim(), " ").to_string()
}

/// Takes copy marks off the end (and "Copy of" off the front) of a lower-case stem, as often as
/// they are stacked: "setup (1) (2)" and "report - copy (3)" both come back clean.
fn strip_copy_marks(stem: &str) -> (String, CopyMark) {
    static PAREN: OnceLock<Regex> = OnceLock::new();
    static WORD: OnceLock<Regex> = OnceLock::new();
    static PREFIX: OnceLock<Regex> = OnceLock::new();
    static WEAK: OnceLock<Regex> = OnceLock::new();
    // " (1)", "(12)", " [2]", "_(3)"
    let paren = re(&PAREN, r"[\s_\-]*[\(\[]\d{1,3}[\)\]]$");
    // " - Copy", "_copy", " copy 2", " - Kopie (2)", " (copy)" in the languages Windows uses most
    let word = re(
        &WORD,
        r"[\s_\-]*[\(\[]?(copy|kopie|kopia|copie|copia|kopio|kopya|cópia)[\)\]]?(\s*[\(\[]?\d{1,3}[\)\]]?)?$",
    );
    let prefix = re(
        &PREFIX,
        r"^(copy of|kopie van|copie de|kopie von|copia de)\s+",
    );
    // "report 1", "report_2", "report-3": one or two digits after a separator, nothing more
    let weak = re(&WEAK, r"[\s_\-](\d{1,2})$");

    let mut s = stem.trim().to_string();
    let mut mark = CopyMark::None;
    loop {
        let before = s.clone();
        if let Some(m) = paren.find(&s) {
            if m.start() > 0 {
                s.truncate(m.start());
                mark = CopyMark::Strong;
            }
        }
        if let Some(m) = word.find(&s) {
            if m.start() > 0 {
                s.truncate(m.start());
                mark = CopyMark::Strong;
            }
        }
        if let Some(m) = prefix.find(&s) {
            if m.end() < s.len() {
                s = s[m.end()..].to_string();
                mark = CopyMark::Strong;
            }
        }
        s = s.trim_end_matches([' ', '_', '-', '.']).to_string();
        if s == before {
            break;
        }
    }
    if mark == CopyMark::None {
        if let Some(c) = weak.captures(&s) {
            let m = c.get(0).unwrap();
            let rest = s[..m.start()].trim_end();
            // Only when what is left still reads as a name, and the number isn't part of a run of
            // numbers like "2024 05" or "track 01 02".
            let prev_numeric = rest
                .rsplit([' ', '_', '-'])
                .next()
                .map(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit()))
                .unwrap_or(true);
            if rest.chars().any(|c| c.is_alphabetic()) && !prev_numeric {
                s = rest.to_string();
                mark = CopyMark::Weak;
            }
        }
    }
    (tidy(&s), mark)
}

/// Words that say how a program is packaged rather than what it is.
const NOISE: &[&str] = &[
    "setup",
    "install",
    "installer",
    "installation",
    "x64",
    "x86",
    "x86_64",
    "amd64",
    "arm64",
    "win64",
    "win32",
    "win",
    "windows",
    "64bit",
    "32bit",
    "64",
    "32",
    "full",
    "offline",
    "online",
    "web",
    "release",
    "stable",
    "final",
    "portable",
    "en",
    "us",
    "en-us",
    "enus",
    "multi",
    "msi",
    "exe",
    "x",
    "bit",
    "beta",
    "latest",
    "signed",
    "lite",
    "free",
];

/// Finds a version in a stem and gives back the stem without it. "vlc-3.0.20-win64" gives
/// [3,0,20]; "v2" and "_v12" count too; "7z2301" (digits glued to a name) counts only when
/// `glued` is allowed, which is for installers.
fn take_version(stem: &str, glued: bool) -> Option<(Vec<u64>, String)> {
    static DOTTED: OnceLock<Regex> = OnceLock::new();
    static VEE: OnceLock<Regex> = OnceLock::new();
    static GLUED: OnceLock<Regex> = OnceLock::new();
    static BUILD: OnceLock<Regex> = OnceLock::new();
    let dotted = re(
        &DOTTED,
        r"(?:^|[\s_\-\.v])(v?(\d{1,5}(?:\.\d{1,6}){1,3}))(?:$|[\s_\-\.a-z(])",
    );
    let vee = re(&VEE, r"(?:^|[\s_\-\.])(v(\d{1,4}))(?:$|[\s_\-\.])");
    let glued_re = re(&GLUED, r"^([a-z0-9]*?[a-z])(\d{3,6})$");
    let build = re(
        &BUILD,
        r"(?:^|[\s_\-])(?:build|b|r|rev)[\s_\-]?(\d{2,7})(?:$|[\s_\-])",
    );

    let parse =
        |s: &str| -> Vec<u64> { s.split('.').filter_map(|p| p.parse::<u64>().ok()).collect() };

    if let Some(c) = dotted.captures(stem) {
        let whole = c.get(1).unwrap();
        let v = parse(c.get(2).unwrap().as_str());
        let mut rest = String::new();
        rest.push_str(&stem[..whole.start()]);
        rest.push(' ');
        rest.push_str(&stem[whole.end()..]);
        return Some((v, rest));
    }
    if let Some(c) = vee.captures(stem) {
        let whole = c.get(1).unwrap();
        let v = parse(c.get(2).unwrap().as_str());
        let rest = format!("{} {}", &stem[..whole.start()], &stem[whole.end()..]);
        return Some((v, rest));
    }
    if let Some(c) = build.captures(stem) {
        let whole = c.get(0).unwrap();
        let v = parse(c.get(1).unwrap().as_str());
        let rest = format!("{} {}", &stem[..whole.start()], &stem[whole.end()..]);
        return Some((v, rest));
    }
    if glued {
        // Look at the first token: "7z2301-x64" -> "7z" + 2301.
        let first_end = stem.find([' ', '_', '-']).unwrap_or(stem.len());
        let token = &stem[..first_end];
        if let Some(c) = glued_re.captures(token) {
            let name = c.get(1).unwrap().as_str();
            let v = parse(c.get(2).unwrap().as_str());
            return Some((v, format!("{} {}", name, &stem[first_end..])));
        }
    }
    None
}

/// The product name words: lower case, packaging words and glued "setup" removed.
pub fn product_words(stem: &str) -> Vec<String> {
    let mut words = Vec::new();
    for raw in stem.split(|c: char| !c.is_alphanumeric() && c != '+') {
        if raw.is_empty() {
            continue;
        }
        let mut w = raw.to_lowercase();
        for glued in ["setup", "installer", "install"] {
            if w.len() > glued.len() + 1 && w.ends_with(glued) {
                w.truncate(w.len() - glued.len());
            }
        }
        if NOISE.contains(&w.as_str()) {
            continue;
        }
        words.push(w);
    }
    words
}

pub fn is_installer_ext(ext: &str) -> bool {
    matches!(
        ext,
        "exe" | "msi" | "msix" | "msixbundle" | "appx" | "appxbundle"
    )
}

pub fn parse(name: &str) -> NameParts {
    let (stem, ext) = split_ext(name);
    let lower = stem.to_lowercase();
    let (base, mark) = strip_copy_marks(&lower);
    let (product, version) = match take_version(&base, is_installer_ext(&ext)) {
        Some((v, rest)) if !v.is_empty() => {
            let words = product_words(&rest);
            if words.is_empty() {
                (None, None)
            } else {
                (Some(words.join(" ")), Some(v))
            }
        }
        _ => (None, None),
    };
    NameParts {
        ext,
        base,
        mark,
        product,
        version,
    }
}

/// The name a file would have without its copy mark: "report (1).pdf" and "report - Copy.pdf"
/// give "report.pdf", "Setup 1.exe" gives "Setup.exe". None when the name carries no mark, or
/// nothing is left of it. The case of what stays is kept.
pub fn clean_name(name: &str) -> Option<String> {
    let (stem, ext) = split_ext(name);
    let lower = stem.to_lowercase();
    let (base, mark) = strip_copy_marks(&lower);
    if mark == CopyMark::None || base.is_empty() {
        return None;
    }
    // Marks sit at the end (or "Copy of" at the start): take the same stretch of the original.
    let n = base.chars().count();
    let total = stem.chars().count();
    if lower.chars().count() != total {
        return None;
    }
    let kept: String = if lower.starts_with(&base) {
        stem.chars().take(n).collect()
    } else if lower.ends_with(&base) {
        stem.chars().skip(total - n).collect()
    } else {
        return None;
    };
    let kept = kept.trim().to_string();
    if kept.is_empty() {
        return None;
    }
    // The extension as written (split_ext lowers it).
    let written = &name[name.len() - ext.len()..];
    Some(if ext.is_empty() {
        kept
    } else {
        format!("{kept}.{written}")
    })
}

/// Compares versions number by number; [3,0] equals [3,0,0].
pub fn cmp_version(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

pub fn version_text(v: &[u64]) -> String {
    v.iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(".")
}

#[cfg(test)]
mod tests {
    use super::clean_name;

    #[test]
    fn clean_names_drop_copy_marks_and_keep_case() {
        assert_eq!(clean_name("report (1).pdf").as_deref(), Some("report.pdf"));
        assert_eq!(
            clean_name("Report - Copy.PDF").as_deref(),
            Some("Report.PDF")
        );
        assert_eq!(clean_name("Setup 1.exe").as_deref(), Some("Setup.exe"));
        assert_eq!(
            clean_name("Copy of Notes.txt").as_deref(),
            Some("Notes.txt")
        );
        assert_eq!(clean_name("report.pdf"), None);
        assert_eq!(clean_name("(1).pdf"), None);
        assert_eq!(clean_name("2024 05.pdf"), None);
    }

    use super::*;

    fn base(n: &str) -> (String, CopyMark) {
        let p = parse(n);
        (p.base, p.mark)
    }

    #[test]
    fn extensions() {
        assert_eq!(split_ext("a.tar.gz"), ("a", "tar.gz".into()));
        assert_eq!(split_ext("Setup.EXE"), ("Setup", "exe".into()));
        assert_eq!(split_ext(".gitignore"), (".gitignore", "".into()));
        assert_eq!(split_ext("archive.7z"), ("archive", "7z".into()));
        assert_eq!(split_ext("Report v1.2"), ("Report v1.2", "".into()));
    }

    #[test]
    fn copy_marks() {
        assert_eq!(base("setup (1).exe"), ("setup".into(), CopyMark::Strong));
        assert_eq!(base("setup(12).exe"), ("setup".into(), CopyMark::Strong));
        assert_eq!(base("photo [2].jpg"), ("photo".into(), CopyMark::Strong));
        assert_eq!(
            base("Report - Copy.pdf"),
            ("report".into(), CopyMark::Strong)
        );
        assert_eq!(
            base("Report - Copy (2).pdf"),
            ("report".into(), CopyMark::Strong)
        );
        assert_eq!(
            base("Report - Kopie.pdf"),
            ("report".into(), CopyMark::Strong)
        );
        assert_eq!(base("report_copy.pdf"), ("report".into(), CopyMark::Strong));
        assert_eq!(
            base("Copy of report.pdf"),
            ("report".into(), CopyMark::Strong)
        );
        assert_eq!(
            base("setup (1) (2).exe"),
            ("setup".into(), CopyMark::Strong)
        );
        assert_eq!(base("report 1.pdf"), ("report".into(), CopyMark::Weak));
        assert_eq!(base("report_2.pdf"), ("report".into(), CopyMark::Weak));
        assert_eq!(base("report.pdf"), ("report".into(), CopyMark::None));
        // Not copies: numbers that belong to the name.
        assert_eq!(base("2024 05.pdf").1, CopyMark::None);
        assert_eq!(base("(1).pdf"), ("(1)".into(), CopyMark::None));
        assert_eq!(base("IMG_0001.jpg").1, CopyMark::None);
    }

    #[test]
    fn versions() {
        let p = parse("vlc-3.0.20-win64.exe");
        assert_eq!(p.product.as_deref(), Some("vlc"));
        assert_eq!(p.version, Some(vec![3, 0, 20]));

        let p = parse("Firefox Setup 120.0.1.exe");
        assert_eq!(p.product.as_deref(), Some("firefox"));
        assert_eq!(p.version, Some(vec![120, 0, 1]));

        let p = parse("7z2301-x64.exe");
        assert_eq!(p.product.as_deref(), Some("7z"));
        assert_eq!(p.version, Some(vec![2301]));

        let p = parse("npp.8.6.2.Installer.x64.exe");
        assert_eq!(p.product.as_deref(), Some("npp"));
        assert_eq!(p.version, Some(vec![8, 6, 2]));

        let p = parse("Thesis_v2.docx");
        assert_eq!(p.product.as_deref(), Some("thesis"));
        assert_eq!(p.version, Some(vec![2]));

        let p = parse("python-3.12.1-amd64.exe");
        assert_eq!(p.product.as_deref(), Some("python"));

        // A copy of a versioned installer is still that version.
        let p = parse("vlc-3.0.20-win64 (1).exe");
        assert_eq!(p.version, Some(vec![3, 0, 20]));
        assert_eq!(p.mark, CopyMark::Strong);

        // Glued digits only count for installers, not for e.g. photos.
        assert_eq!(parse("IMG1234.jpg").version, None);
        assert_eq!(parse("holiday.jpg").version, None);
    }

    #[test]
    fn version_order() {
        use std::cmp::Ordering::*;
        assert_eq!(cmp_version(&[3, 0], &[3, 0, 0]), Equal);
        assert_eq!(cmp_version(&[3, 0, 20], &[3, 0, 9]), Greater);
        assert_eq!(cmp_version(&[2301], &[2408]), Less);
    }

    #[test]
    fn product_word_cleanup() {
        assert_eq!(product_words("ChromeSetup"), vec!["chrome"]);
        assert_eq!(product_words("SteamSetup"), vec!["steam"]);
        assert_eq!(product_words("Notepad++ installer x64"), vec!["notepad++"]);
    }
}

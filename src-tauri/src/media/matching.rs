use serde::Serialize;
use std::collections::HashSet;

#[derive(Clone, Serialize)]
pub(crate) struct MediaSearchResult {
    pub(crate) source_id: String,
    pub(crate) source_url: String,
    pub(crate) title: String,
    pub(crate) creator: String,
    pub(crate) duration_label: String,
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) thumbnail: String,
    pub(crate) extractor: String,
    pub(crate) similarity: f64,
    pub(crate) match_reasons: Vec<String>,
}

fn fold_search_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut previous_space = true;
    for character in value.chars().flat_map(char::to_lowercase) {
        let folded = match character {
            'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            value if value.is_alphanumeric() => value,
            _ => ' ',
        };
        if folded == ' ' {
            if !previous_space {
                output.push(' ');
                previous_space = true;
            }
        } else {
            output.push(folded);
            previous_space = false;
        }
    }
    output.trim().to_string()
}

fn normalized_search_tokens(value: &str) -> HashSet<String> {
    fold_search_text(value)
        .split_whitespace()
        .filter(|token| token.len() >= 2)
        .map(str::to_string)
        .collect()
}

pub(crate) fn token_similarity(left: &str, right: &str) -> f64 {
    let left = normalized_search_tokens(left);
    let right = normalized_search_tokens(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count() as f64;
    let union = left.union(&right).count() as f64;
    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}

fn bigram_similarity(left: &str, right: &str) -> f64 {
    let pairs = |value: &str| {
        let characters = fold_search_text(value)
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<Vec<_>>();
        characters
            .windows(2)
            .map(|pair| (pair[0], pair[1]))
            .collect::<HashSet<_>>()
    };
    let left = pairs(left);
    let right = pairs(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count() as f64;
    (2.0 * intersection / (left.len() + right.len()) as f64).clamp(0.0, 1.0)
}

pub(crate) fn title_similarity(left: &str, right: &str) -> f64 {
    let left_folded = fold_search_text(left);
    let right_folded = fold_search_text(right);
    if left_folded.is_empty() || right_folded.is_empty() {
        return 0.0;
    }
    let containment = if left_folded == right_folded {
        1.0
    } else if left_folded.contains(&right_folded) || right_folded.contains(&left_folded) {
        0.82
    } else {
        0.0
    };
    (token_similarity(&left_folded, &right_folded) * 0.55
        + bigram_similarity(&left_folded, &right_folded) * 0.30
        + containment * 0.15)
        .clamp(0.0, 1.0)
}

pub(crate) fn match_reasons(
    title_score: f64,
    creator_score: f64,
    duration_score: f64,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if title_score >= 0.76 {
        reasons.push("Título casi idéntico".into());
    } else if title_score >= 0.48 {
        reasons.push("Coincide en palabras clave".into());
    }
    if creator_score >= 0.72 {
        reasons.push("Mismo autor o canal".into());
    }
    if duration_score >= 0.90 {
        reasons.push("Duración prácticamente igual".into());
    } else if duration_score >= 0.76 {
        reasons.push("Duración muy parecida".into());
    }
    reasons
}

pub(crate) fn duration_similarity(expected: Option<f64>, candidate: Option<f64>) -> f64 {
    let (Some(expected), Some(candidate)) = (expected, candidate) else {
        return 0.5;
    };
    if expected <= 0.0 || candidate <= 0.0 {
        return 0.5;
    }
    let difference = (expected - candidate).abs();
    (1.0 - difference / expected.max(candidate)).clamp(0.0, 1.0)
}

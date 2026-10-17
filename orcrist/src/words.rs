//! The words text and names are made of.

/// Lowercase words, identifiers split at underscores and at camelCase humps.
pub fn words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut previous_lower = false;
    for character in text.chars() {
        let breaks = !character.is_alphanumeric() || (character.is_uppercase() && previous_lower);
        if breaks && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        if character.is_alphanumeric() {
            word.extend(character.to_lowercase());
        }
        previous_lower = character.is_lowercase();
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

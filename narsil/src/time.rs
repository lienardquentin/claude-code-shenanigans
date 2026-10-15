//! Dates as the chronicle writes them: `3019-03-07T21:14:00Z`, which sort as text.

use std::time::{SystemTime, UNIX_EPOCH};

/// Days from 1970-01-01 to the given day of the proleptic Gregorian calendar.
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Seconds since 1970-01-01T00:00:00Z, as the chronicle writes a date.
pub fn iso(secs: i64) -> String {
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let rest = secs.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

pub fn now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() as i64);
    iso(secs)
}

/// A date as `ls` is asked for one, `3019-03-08` or `3019-03-08T06:00:00Z`, in the chronicle's own form. A bare
/// date is the start of its day, or its last second when `end_of_day`, so that it takes in the whole day.
pub fn parse(text: &str, end_of_day: bool) -> Option<String> {
    let (date, time) = match text.split_once('T') {
        Some((date, time)) => (date, Some(time)),
        None => (text, None),
    };
    let [year, month, day] = fields::<3>(date, '-', &[4, 2, 2])?;
    if !(1..=12).contains(&month) || day < 1 {
        return None;
    }
    let next = if month == 12 {
        days_from_civil(year + 1, 1, 1)
    } else {
        days_from_civil(year, month + 1, 1)
    };
    if days_from_civil(year, month, 1) + day - 1 >= next {
        return None;
    }
    let [hour, minute, second] = match time {
        Some(time) => fields::<3>(time.strip_suffix('Z')?, ':', &[2, 2, 2])?,
        None if end_of_day => [23, 59, 59],
        None => [0, 0, 0],
    };
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(iso(days_from_civil(year, month, day) * 86_400
        + hour * 3600
        + minute * 60
        + second))
}

/// The `N` numbers of `text` split on `separator`, each of as many digits as `widths` says.
fn fields<const N: usize>(text: &str, separator: char, widths: &[usize; N]) -> Option<[i64; N]> {
    let mut parts = text.split(separator);
    let mut numbers = [0; N];
    for (number, width) in numbers.iter_mut().zip(widths) {
        let part = parts.next()?;
        if part.len() != *width || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *number = part.parse().ok()?;
    }
    parts.next().is_none().then_some(numbers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_real_date_is_read() {
        assert_eq!(parse("3019-03-08", false).unwrap(), "3019-03-08T00:00:00Z");
        assert_eq!(parse("3019-03-08", true).unwrap(), "3019-03-08T23:59:59Z");
        assert_eq!(parse("3019-03-08T06:00:00Z", true).unwrap(), "3019-03-08T06:00:00Z");
        assert_eq!(parse("2024-02-29", false).unwrap(), "2024-02-29T00:00:00Z");
        for bad in [
            "",
            "garbage",
            "3019-02-30",
            "3019-13-01",
            "3019-00-10",
            "3019-03-00",
            "3019-3-8",
            "3019-03-08T24:00:00Z",
            "3019-03-08T06:00:00",
            "3019-03-08T06:00Z",
            "3019-03-08Tx",
        ] {
            assert!(parse(bad, false).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_date_goes_there_and_back() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            iso(days_from_civil(3019, 3, 7) * 86_400 + 76_440),
            "3019-03-07T21:14:00Z"
        );
        assert_eq!(iso(days_from_civil(2024, 2, 29) * 86_400), "2024-02-29T00:00:00Z");
    }
}

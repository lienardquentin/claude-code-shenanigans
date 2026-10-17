use std::collections::HashMap;
use std::fmt;

#[derive(Debug, Default)]
pub struct Inventory {
    stock: HashMap<String, u32>,
}

#[derive(Debug, PartialEq)]
pub enum InventoryError {
    Unknown(String),
    Short { sku: String, wanted: u32, held: u32 },
}

impl fmt::Display for InventoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InventoryError::Unknown(sku) => write!(f, "no item {sku}"),
            InventoryError::Short { sku, wanted, held } => write!(f, "{wanted} of {sku} wanted, {held} held"),
        }
    }
}

impl Inventory {
    pub fn receive(&mut self, sku: &str, count: u32) {
        *self.stock.entry(sku.to_string()).or_default() += count;
    }

    pub fn take(&mut self, sku: &str, wanted: u32) -> Result<u32, InventoryError> {
        let held = self
            .stock
            .get_mut(sku)
            .ok_or_else(|| InventoryError::Unknown(sku.to_string()))?;
        if *held < wanted {
            return Err(InventoryError::Short { sku: sku.to_string(), wanted, held: *held });
        }
        *held -= wanted;
        Ok(*held)
    }
}

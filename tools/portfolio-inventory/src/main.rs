use std::path::Path;
use std::process::ExitCode;

use ores_portfolio_inventory::load_and_validate;

fn main() -> ExitCode {
    let path = Path::new("portfolio/inventory.json");
    match load_and_validate(path) {
        Ok(summary) => {
            match serde_json::to_string_pretty(&summary) {
                Ok(output) => {
                    println!("{output}");
                    return ExitCode::SUCCESS;
                }
                Err(error) => {
                    eprintln!("could not serialize inventory validation summary: {error}");
                    return ExitCode::FAILURE;
                }
            }
        }
        Err(errors) => {
            for error in errors {
                eprintln!("portfolio inventory validation failed: {error}");
            }
            return ExitCode::FAILURE;
        }
    }
}

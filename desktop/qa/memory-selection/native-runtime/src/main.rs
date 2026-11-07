//! Isolated HBM-00 dependency probe; no Hub integration, network or downloads.
use fastembed::{InitOptionsUserDefined, Pooling, TextEmbedding, TokenizerFiles, UserDefinedEmbeddingModel};
use serde::Deserialize;
use serde_json::json;
use std::error::Error;
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    texts: Vec<String>,
}

fn main() -> Result<(), Box<dyn Error>> {
    let start = Instant::now();
    let path = PathBuf::from(std::env::args_os().nth(1).ok_or("model directory missing")?);
    let files = TokenizerFiles {
        tokenizer_file: fs::read(path.join("tokenizer.json"))?,
        config_file: fs::read(path.join("config.json"))?,
        special_tokens_map_file: fs::read(path.join("special_tokens_map.json"))?,
        tokenizer_config_file: fs::read(path.join("tokenizer_config.json"))?,
    };
    let supplied = UserDefinedEmbeddingModel::new(fs::read(path.join("model_optimized.onnx"))?, files)
        .with_pooling(Pooling::Cls);
    let mut model = TextEmbedding::try_new_from_user_defined(
        supplied,
        InitOptionsUserDefined::new().with_max_length(512).with_intra_threads(2),
    )?;
    let mut out = io::BufWriter::new(io::stdout().lock());
    writeln!(out, "{}", json!({"event":"ready","initMs":start.elapsed().as_secs_f64()*1000.0,"dimension":512,"backend":"Rust FastEmbed+ONNX Runtime,CPU"}))?;
    out.flush()?;
    let mut reader = io::BufReader::new(io::stdin().lock());
    loop {
        let mut line = Vec::new();
        let n = (&mut reader).take(1_048_577).read_until(b'\n', &mut line)?;
        if n == 0 { break; }
        if n > 1_048_576 || *line.last().ok_or("empty request")? != b'\n' {
            return Err("request exceeds1MiB or has no terminal newline".into());
        }
        let request: Request = serde_json::from_slice(&line)?;
        if request.texts.is_empty() || request.texts.len() > 64 || request.texts.iter().any(|s| s.len() > 16384) {
            return Err("request batch/text bound exceeded".into());
        }
        let began = Instant::now();
        let vectors = model.embed(&request.texts, Some(64))?;
        if vectors.len() != request.texts.len() || vectors.iter().any(|v| v.len()!=512 || v.iter().any(|x| !x.is_finite())) {
            return Err("invalid vector output".into());
        }
        writeln!(out,"{}",json!({"id":request.id,"vectors":vectors,"embeddingMs":began.elapsed().as_secs_f64()*1000.0}))?;
        out.flush()?;
    }
    Ok(())
}

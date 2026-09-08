fn main() {
    println!("cargo:rerun-if-changed=abi/erc4626.json");
    println!("cargo:rerun-if-changed=proto/indexloom/erc4626/v1/vault.proto");

    substreams_ethereum::Abigen::new("Erc4626", "abi/erc4626.json")
        .expect("load ERC-4626 ABI")
        .generate()
        .expect("generate ERC-4626 bindings")
        .write_to_file("src/abi/erc4626.rs")
        .expect("write ERC-4626 bindings");

    prost_build::compile_protos(&["proto/indexloom/erc4626/v1/vault.proto"], &["proto/"])
        .expect("compile IndexLoom protobuf definitions");
}

fn main() {
    println!("cargo:rerun-if-changed=static");
    println!("cargo:rerun-if-changed=vendor");
}

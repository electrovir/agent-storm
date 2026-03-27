.PHONY: check test lint all

all: check test lint

check:
	cargo check

test:
	cargo test

lint:
	cargo clippy -- -D warnings

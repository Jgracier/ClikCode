#!/usr/bin/env bash
set -euo pipefail
mkdir -p result runtime models
lscpu > result/hardware.txt
cat /proc/meminfo >> result/hardware.txt
uname -a >> result/hardware.txt

archive=llama-b11194-bin-ubuntu-x64.tar.gz
curl -fL --retry 3 --retry-delay 2 -o "$archive" "https://github.com/ggml-org/llama.cpp/releases/download/b11194/$archive"
echo "527c09064f3c89e4b6e1008a641e31903a04ccdd1c69abd0752acbbd4e1905f6  $archive" | sha256sum -c -
tar -xf "$archive" -C runtime
bench=$(find runtime -name llama-bench -type f -print -quit)
test -n "$bench"
bench=$(realpath "$bench")
export LD_LIBRARY_PATH="$(dirname "$bench")"

gcc -O2 -fopenmp .github/bench/stream.c -o stream
for threads in 1 2 4; do
  OMP_NUM_THREADS="$threads" ./stream >> result/bandwidth.txt
done

download_model() {
  local repo=$1 revision=$2 name=$3 digest=$4
  curl -fL --retry 3 --retry-delay 2 -o "models/$name" "https://huggingface.co/$repo/resolve/$revision/$name"
  echo "$digest  models/$name" | sha256sum -c -
}
download_model 'unsloth/Qwen3.5-4B-GGUF' 'e87f176479d0855a907a41277aca2f8ee7a09523' \
  'Qwen3.5-4B-Q4_K_M.gguf' '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4'
download_model 'unsloth/Qwen3.5-9B-GGUF' '3885219b6810b007914f3a7950a8d1b469d598a5' \
  'Qwen3.5-9B-Q4_K_M.gguf' '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8'

for name in Qwen3.5-4B-Q4_K_M.gguf Qwen3.5-9B-Q4_K_M.gguf; do
  for threads in 1 2 4; do
    "$bench" -m "models/$name" -t "$threads" -fa 1 -ctk f16 -ctv f16 \
      -d 0 -p 512 -n 32 -r 2 -o jsonl > "result/$name-t$threads-d0.jsonl"
  done
  "$bench" -m "models/$name" -t 4 -fa 1 -ctk f16 -ctv f16 \
    -d 4096 -p 512 -n 32 -r 2 -o jsonl > "result/$name-t4-d4096.jsonl"
done

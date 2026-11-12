"""
Flowie — Qwen-Image-Edit recon Space (Gradio SDK, ZeroGPU).

Why self-hosted instead of the official Qwen Space: the official
Qwen/Qwen-Image-Edit-2511 Space declares @spaces.GPU(duration=180) and the
ZeroGPU scheduler currently refuses its jobs ("requested GPU duration (360s)
is larger than the maximum allowed" — verified Sept 2026, two attempts, zero
quota burned since the GPU is never claimed). This Space runs the SAME base
weights at reduced steps, so a call fits a 60 s reservation
and the free tier can still afford ~1 spike call/day alongside TryOffDiff.

Model: Qwen/Qwen-Image-Edit-2511 (20B MMDiT, Apache-2.0), base weights at
6-10 steps. No Lightning LoRA: no 2511-specific Lightning adapter exists on
the Hub (lightx2v/Qwen-Image-Lightning ships 2509/base-Edit adapters only;
cross-version LoRAs were rejected as unpredictable). Text encoder is the
bundled Qwen2.5-VL. No DashScope, no prompt-polisher, no API keys in code —
the caller sends the final Wardrobe-style reconstruction prompt verbatim.

Job: garment crop in → complete empty garment re-rendered on a solid chroma
background (as instructed by the prompt) → PIL out. Deterministic chroma
extraction happens caller-side (scripts/recon-harness.mjs), never here.

ZeroGPU discipline: only generate() touches the GPU (@spaces.GPU). Model
load happens once at startup; _prep stays on CPU.

API (named endpoint "/predict" — stable for the harness + edge function):
  inputs:  input_image (filepath), prompt (str), seed (int), num_steps (4-10)
  output:  reconstructed image (PIL, 1024x1024), unpolished (caller owns
           chroma extraction + studio composite, so no CPU polish here)

Fixed operating point: guidance 4.0 (official Space default), 1024x1024,
base weights. Callers vary steps 4-10 (default 8); the 60 s reservation is
the longest ZeroGPU currently schedules (120 s+ stalls — verified Sept 2026).
"""

import gradio as gr
import spaces
import torch
from diffusers import QwenImageEditPlusPipeline
from PIL import Image

MODEL_ID = "Qwen/Qwen-Image-Edit-2511"

SIZE = 1024
GUIDANCE = 4.0
DEFAULT_STEPS = 8

print("[qwen-recon] loading pipeline…", flush=True)
_pipe = QwenImageEditPlusPipeline.from_pretrained(
    MODEL_ID,
    torch_dtype=torch.bfloat16,
).to("cuda")
_pipe.set_progress_bar_config(disable=True)


def _prep(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    return img.resize((SIZE, SIZE), Image.LANCZOS)


@spaces.GPU(duration=60)
def generate(input_image, prompt: str, seed: int = 42, num_steps: int = DEFAULT_STEPS):
    """Qwen edit inference. GPU is claimed only inside this function."""
    if input_image is None:
        raise gr.Error("Upload a garment crop first.")
    if not prompt:
        raise gr.Error("A reconstruction prompt is required.")
    init = _prep(input_image if isinstance(input_image, Image.Image) else Image.open(input_image))

    num_steps = int(max(4, min(10, round(num_steps))))
    generator = torch.Generator(device="cpu").manual_seed(int(seed))
    out = _pipe(
        image=init,
        prompt=prompt,
        height=SIZE,
        width=SIZE,
        negative_prompt=" ",
        num_inference_steps=num_steps,
        generator=generator,
        true_cfg_scale=GUIDANCE,
    ).images[0]
    return out


def predict(input_image, prompt: str, seed: int = 42, num_steps: int = DEFAULT_STEPS):
    """Public endpoint: GPU inference, no CPU polish (caller owns chroma)."""
    return generate(input_image, prompt, seed, num_steps)


with gr.Blocks(title="Flowie Qwen recon (Image-Edit-2511, ZeroGPU)") as demo:
    gr.Markdown(
        "# Flowie Qwen recon — Qwen-Image-Edit-2511 on ZeroGPU\n"
        "Input = garment crop + evidence-bound reconstruction prompt. Output = complete "
        "empty garment on solid chroma (1024×1024). Fixed guidance 4.0, base weights, "
        "4–10 steps (default 8). "
        "Chroma extraction + studio composite run caller-side (deterministic, zero quota)."
    )
    with gr.Row():
        with gr.Column():
            in_img = gr.Image(type="filepath", label="Input garment crop")
            prompt = gr.Textbox(
                label="Reconstruction prompt (verbatim, no server-side rewrite)",
                lines=6,
            )
            with gr.Row():
                steps = gr.Slider(4, 10, value=DEFAULT_STEPS, step=1, label="Steps (4-10)")
                seed = gr.Number(value=42, precision=0, label="Seed")
            btn = gr.Button("Reconstruct", variant="primary")
        with gr.Column():
            out_img = gr.Image(type="pil", label="Reconstruction (chroma)")
    btn.click(
        fn=predict,
        inputs=[in_img, prompt, seed, steps],
        outputs=out_img,
        api_name="predict",
    )

if __name__ == "__main__":
    demo.queue().launch()

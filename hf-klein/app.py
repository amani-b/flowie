"""
Flowie — FLUX.2-klein detail spike Space (Gradio SDK, ZeroGPU).

Bounded experiment (max 1–2 calls, Track 2): can a small open editor
preserve difficult garment details (GUESS side tape, small logos, graphics)
that TryOffDiff drops? Sole question — if no material gain, the renderer
search stops and TryOffDiff stands alone. Do NOT broaden this Space.

Model: black-forest-labs/FLUX.2-klein-base-4B (4B rectified-flow,
Apache-2.0, ~16 GB total) via diffusers Flux2KleinPipeline. Same
image-edit call shape as the model card: pipe(image, prompt).

Job: garment crop in + verbatim reconstruction prompt → complete empty
garment on solid chroma (as instructed by the prompt) → PIL out.
Deterministic chroma extraction happens caller-side
(scripts/recon-harness.mjs --klein), never here.

ZeroGPU discipline: only generate() touches the GPU (@spaces.GPU,
duration=60 — 30 s jobs schedule reliably on this account; the 20B Qwen
build proved 120 s+ reservations stall). Model load once at startup.
Startup `.to("cuda")` follows the proven hf-tryoff/hf-qwen pattern
(build-safe under ZeroGPU; the real move happens at GPU acquisition).

PUBLIC MODEL — no license acceptance, no Space secret: Apache-2.0,
ungated (verified on the model page Sept 2026). Do NOT add HF_TOKEN to
this Space for download. Caller-side HF_TOKEN (local .env) is only
needed if the Space itself is created Private.

API (named endpoint "/predict" — stable for the harness):
  inputs:  input_image (filepath), prompt (str), seed (int),
           num_steps (8-28, default 20)
  output:  reconstructed image (PIL, 1024x1024), unpolished
"""

import gradio as gr
import spaces
import torch
from diffusers import Flux2KleinPipeline
from PIL import Image

MODEL_ID = "black-forest-labs/FLUX.2-klein-base-4B"

SIZE = 1024
GUIDANCE = 4.0
DEFAULT_STEPS = 20

print("[klein] loading pipeline…", flush=True)
_pipe = Flux2KleinPipeline.from_pretrained(
    MODEL_ID,
    dtype=torch.bfloat16,
).to("cuda")
_pipe.set_progress_bar_config(disable=True)


def _prep(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    return img.resize((SIZE, SIZE), Image.LANCZOS)


@spaces.GPU(duration=60)
def generate(input_image, prompt: str, seed: int = 42, num_steps: int = DEFAULT_STEPS):
    """Klein edit inference. GPU is claimed only inside this function."""
    if input_image is None:
        raise gr.Error("Upload a garment crop first.")
    if not prompt:
        raise gr.Error("A reconstruction prompt is required.")
    init = _prep(input_image if isinstance(input_image, Image.Image) else Image.open(input_image))

    num_steps = int(max(8, min(28, round(num_steps))))
    generator = torch.Generator(device="cpu").manual_seed(int(seed))
    out = _pipe(
        image=init,
        prompt=prompt,
        height=SIZE,
        width=SIZE,
        guidance_scale=GUIDANCE,
        num_inference_steps=num_steps,
        generator=generator,
    ).images[0]
    return out


def predict(input_image, prompt: str, seed: int = 42, num_steps: int = DEFAULT_STEPS):
    """Public endpoint: GPU inference, no CPU polish (caller owns chroma)."""
    return generate(input_image, prompt, seed, num_steps)


with gr.Blocks(title="Flowie klein detail spike (FLUX.2-klein-base-4B, ZeroGPU)") as demo:
    gr.Markdown(
        "# Flowie klein detail spike — FLUX.2-klein-base-4B on ZeroGPU\n"
        "BOUNDED EXPERIMENT (1–2 calls): garment crop + verbatim reconstruction "
        "prompt in, complete empty garment on solid chroma out (1024×1024). "
        "Chroma extraction + QA run caller-side."
    )
    with gr.Row():
        with gr.Column():
            in_img = gr.Image(type="filepath", label="Input garment crop")
            prompt = gr.Textbox(
                label="Reconstruction prompt (verbatim, no server-side rewrite)",
                lines=6,
            )
            with gr.Row():
                steps = gr.Slider(8, 28, value=DEFAULT_STEPS, step=1, label="Steps (8-28)")
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

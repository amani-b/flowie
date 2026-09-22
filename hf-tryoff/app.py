"""
Flowie — free AI flat-lay Space (Gradio SDK, ZeroGPU).

Model: rizavelioglu TryOffDiffv2-MGT ("tryoffdiffv2_multi.pth") — the
multi-garment virtual try-off model (ICCVW'25). Input = a photo of a
garment (worn, hanging, or flat); output = the same garment rebuilt as a
canonical flat-lay product shot (512x512). SigLIP visual conditioning keeps
colors/prints/logos faithful; no text prompt involved, so nothing can drift
via language.

Adapted from the upstream demo
(https://huggingface.co/spaces/rizavelioglu/tryoffdiff, app.py) with three
deliberate simplifications for this job:
  - MULTI MODEL ONLY (one weight file, upper/lower/dress via class label).
    Upstream notes single-category models are slightly better, but one model
    keeps ZeroGPU memory headroom and the deploy trivial.
  - SINGLE /predict ENDPOINT (input_image, garment_class, seed) so the
    Supabase edge function + Node spike can pin fn_index=0 forever. No tabs.
  - NO ESRGAN upscaler (VRAM + seconds). Classical CPU polish instead —
    autocontrast/saturation/crisp, zero quota, same as the schnell Space.

Fixed operating point: 20 steps, guidance 2.0, seed 42 (upstream demo
defaults — their examples all run 20 steps). Exposed as constants, not UI,
so edge callers can't accidentally order a 1000-step run.

ZeroGPU discipline: only generate() touches the GPU (@spaces.GPU). Model +
SigLIP + VAE load once at startup; _prep + _polish stay on CPU.

GATED WEIGHTS: CompVis/stable-diffusion-v1-4 (UNet base) and
google/siglip-base-patch16-512 may require accepting their license pages +
an HF_TOKEN Space Secret (Settings -> Secrets) so the build can download.
No token in code, ever.

LICENSE NOTICE (important): upstream code + weights are SSPL — academic /
research use. Flowie uses this Space at prototype scale; a commercial launch
must re-check compliance (or swap the engine). See README.md.

API (named endpoint "/predict" — stable for the edge function + spike):
  inputs:  input_image (filepath), garment_class ("upper"|"lower"|"dress"),
           seed (int)
  output:  flat-lay garment image (PIL, 512x512), polished
"""

import time

import gradio as gr
import spaces
import torch
import torchvision.transforms.v2 as transforms
from torchvision.io import read_image
from diffusers import AutoencoderKL, EulerDiscreteScheduler
from transformers import SiglipImageProcessor, SiglipVisionModel
from huggingface_hub import hf_hub_download
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

from model import create_model

REPO_ID = "rizavelioglu/tryoffdiff"
MULTI_PTH = "tryoffdiffv2_multi.pth"
SIGLIP_CKPT = "google/siglip-base-patch16-512"
VAE_ID = "stabilityai/sd-vae-ft-mse"

STEPS = 20
GUIDANCE = 2.0
SEED_DEFAULT = 42

LABEL = {"upper": 0, "lower": 1, "dress": 2}

device = "cuda"


# Custom transform to pad images to square (upstream verbatim).
class PadToSquare:
    def __call__(self, img):
        _, h, w = img.shape
        max_side = max(h, w)
        pad_h = (max_side - h) // 2
        pad_w = (max_side - w) // 2
        padding = (pad_w, pad_h, max_side - w - pad_w, max_side - h - pad_h)
        return transforms.functional.pad(img, padding, padding_mode="edge")


img_enc_transform = transforms.Compose(
    [
        PadToSquare(),
        transforms.Resize((512, 512)),
        transforms.ToDtype(torch.float32, scale=True),
        transforms.Normalize(mean=[0.5], std=[0.5]),
    ]
)

print("[tryoff] loading SigLIP…", flush=True)
img_processor = SiglipImageProcessor.from_pretrained(
    SIGLIP_CKPT, do_resize=False, do_rescale=False, do_normalize=False
)
img_enc = SiglipVisionModel.from_pretrained(SIGLIP_CKPT).eval().to(device)

print("[tryoff] loading VAE + scheduler…", flush=True)
vae = AutoencoderKL.from_pretrained(VAE_ID).eval().to(device)
scheduler = EulerDiscreteScheduler.from_pretrained(
    hf_hub_download(repo_id=REPO_ID, filename="scheduler/scheduler_config_v2.json")
)
scheduler.is_scale_input_called = True  # suppress warning

print("[tryoff] loading MGT multi model…", flush=True)
t0 = time.time()
_path = hf_hub_download(repo_id=REPO_ID, filename=MULTI_PTH)
_state = torch.load(_path, weights_only=True, map_location=device)
_state = {k.replace("_orig_mod.", ""): v for k, v in _state.items()}
model = create_model("TryOffDiffv2").to(device)
model.load_state_dict(_state, strict=True)
model.eval()
print(f"[tryoff] model ready in {time.time() - t0:.1f}s", flush=True)


def _prep(filepath: str) -> torch.Tensor:
    """Reference photo -> SigLIP conditioning tensor (CPU)."""
    cond_image = img_enc_transform(read_image(filepath))
    inputs = {k: v.to(device) for k, v in img_processor(images=cond_image, return_tensors="pt").items()}
    with torch.no_grad():
        return img_enc(**inputs).last_hidden_state.to(device)


@spaces.GPU(duration=30)
@torch.no_grad()
def generate(input_image, garment_class: str, seed: int = SEED_DEFAULT):
    """Try-off inference. GPU is claimed only inside this function."""
    if input_image is None:
        raise gr.Error("Upload a garment photo first.")
    if garment_class not in LABEL:
        raise gr.Error("Pick upper, lower, or dress.")
    filepath = input_image if isinstance(input_image, str) else input_image.name
    cond_emb = _prep(filepath)
    label = torch.tensor([LABEL[garment_class]], device=device, dtype=torch.int64)
    uncond_emb = torch.zeros_like(cond_emb)

    scheduler.set_timesteps(STEPS)
    generator = torch.Generator(device=device).manual_seed(int(seed))
    x = torch.randn(1, 4, 64, 64, generator=generator, device=device)

    with torch.autocast(device):
        last = None
        for t in scheduler.timesteps:
            t = t.to(device)
            noise_pred = model(
                torch.cat([x] * 2),
                t,
                torch.cat([uncond_emb, cond_emb]),
                torch.cat([label, label]),
            ).chunk(2)
            noise_pred = noise_pred[0] + GUIDANCE * (noise_pred[1] - noise_pred[0])
            last = scheduler.step(noise_pred, t, x)
            x = last.prev_sample

    # Decode the denoised x0 estimate (upstream verbatim — not the raw latent).
    decoded = vae.decode(1 / vae.config.scaling_factor * last.pred_original_sample).sample
    images = (decoded / 2 + 0.5).cpu()
    return transforms.ToPILImage()(images[0])


def _polish(img: Image.Image) -> Image.Image:
    """Deterministic classical finish (CPU-only, zero quota). Gentle by
    design: NO autocontrast (it posterizes the model's flat studio
    backdrops into visible banding) — small global saturation/contrast
    plus light sharpen only. No hue shift, no local edits."""
    img = img.convert("RGB")
    img = ImageEnhance.Color(img).enhance(1.04)
    img = ImageEnhance.Contrast(img).enhance(1.02)
    return img.filter(ImageFilter.UnsharpMask(radius=2, percent=40, threshold=4))


def predict(input_image, garment_class: str, seed: int = SEED_DEFAULT):
    """Public endpoint: GPU try-off + free CPU polish."""
    return _polish(generate(input_image, garment_class, seed))


with gr.Blocks(title="Flowie free flat-lay (TryOffDiffv2-MGT, ZeroGPU)") as demo:
    gr.Markdown(
        "# Flowie free flat-lay — TryOffDiffv2-MGT on ZeroGPU\n"
        "Input = garment photo (worn, hanging, or flat). Output = same garment, "
        "canonical flat-lay (512x512). Class-locked: upper / lower / dress. "
        "Fixed 20 steps, guidance 2.0. Classical polish is applied free on CPU."
    )
    with gr.Row():
        with gr.Column():
            in_img = gr.Image(type="filepath", label="Input garment photo")
            garment = gr.Dropdown(
                ["upper", "lower", "dress"], value="upper", label="Garment class"
            )
            seed = gr.Number(value=SEED_DEFAULT, precision=0, label="Seed")
            btn = gr.Button("Flat-lay", variant="primary")
        with gr.Column():
            out_img = gr.Image(type="pil", label="Flat-lay result")
    btn.click(
        fn=predict,
        inputs=[in_img, garment, seed],
        outputs=out_img,
        api_name="predict",
    )

if __name__ == "__main__":
    demo.queue().launch()

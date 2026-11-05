"""Create fake-meta label and frame fixtures with torchvision Mask R-CNN.

Usage: da3/Scripts/python.exe backend/tools/local-labels.py CLIP OUTPUT_DIR CLASS_ID
COCO class IDs include person=1 and dog=18. The first run downloads torchvision's
public Mask R-CNN weights if they are not already cached.
"""
import argparse
from pathlib import Path
import subprocess

import cv2
import numpy as np
import torch
from torchvision.models.detection import maskrcnn_resnet50_fpn, MaskRCNN_ResNet50_FPN_Weights


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('clip')
    parser.add_argument('output', type=Path)
    parser.add_argument('class_id', type=int)
    args = parser.parse_args()
    frames = args.output / 'frames'
    labels = args.output / 'labels'
    frames.mkdir(parents=True, exist_ok=True)
    labels.mkdir(parents=True, exist_ok=True)
    if any(frames.iterdir()) or any(labels.iterdir()):
        raise SystemExit('Output frames and labels directories must be empty')
    subprocess.run(['ffmpeg', '-v', 'error', '-i', args.clip, '-vf', 'fps=15',
                    '-start_number', '0', str(frames / 'f%05d.jpg')], check=True)
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    weights = MaskRCNN_ResNet50_FPN_Weights.DEFAULT
    model = maskrcnn_resnet50_fpn(weights=weights).to(device).eval()
    previous_box = None
    with torch.inference_mode():
        for i, frame_path in enumerate(sorted(frames.glob('*.jpg'))):
            image = cv2.imread(str(frame_path))
            tensor = torch.from_numpy(cv2.cvtColor(image, cv2.COLOR_BGR2RGB)).permute(2, 0, 1).to(device).float() / 255
            result = model([tensor])[0]
            indices = torch.where((result['labels'] == args.class_id) & (result['scores'] >= 0.6))[0]
            if not len(indices):
                raise RuntimeError(f'No confident subject detected in frame {i}; incomplete fixture')
            if previous_box is None:
                boxes = result['boxes'][indices]
                centers = (boxes[:, :2] + boxes[:, 2:]) / 2
                center = torch.tensor([image.shape[1] / 2, image.shape[0] / 2], device=device)
                chosen = indices[((centers - center) ** 2).sum(dim=1).argmin()]
            else:
                boxes = result['boxes'][indices]
                intersection = (torch.minimum(boxes[:, 2:], previous_box[2:]) - torch.maximum(boxes[:, :2], previous_box[:2])).clamp(min=0).prod(dim=1)
                union = (boxes[:, 2:] - boxes[:, :2]).prod(dim=1) + (previous_box[2:] - previous_box[:2]).prod() - intersection
                overlap = intersection / union.clamp(min=1)
                if overlap.max() < 0.1:
                    raise RuntimeError(f'Subject lost in frame {i}; incomplete fixture')
                chosen = indices[overlap.argmax()]
            previous_box = result['boxes'][chosen]
            mask = (result['masks'][chosen, 0] >= 0.5).byte().cpu().numpy()
            if not cv2.imwrite(str(labels / f'l{i:05d}.png'), mask):
                raise RuntimeError(f'Could not write label {i}')
            print(f'{i}: {int(mask.sum())} pixels', flush=True)


if __name__ == '__main__':
    main()

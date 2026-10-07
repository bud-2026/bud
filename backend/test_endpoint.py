import requests

url = "http://localhost:8000/tts"
payload = {
    "text": "This is a Minecraft villager - specifically a Fisherman (green coat, beanie, standing in water). He is a passive NPC whose job is to offer trades/transactions with the player (typically fishing rods, tropical fish, pufferfish, sand and coral), and he can be given a bed + job-site block, leveled up through trading, and bred with other villagers. You brought him into the world using the Villager spawn egg currently selected in your hotbar.",
}

response = requests.post(url, json=payload)

if response.status_code == 200:
    with open("endpoint_result.wav", "wb") as f:
        f.write(response.content)
    print("Audio successfully saved to endpoint_result.wav")
else:
    print(f"Error {response.status_code}: {response.text}")
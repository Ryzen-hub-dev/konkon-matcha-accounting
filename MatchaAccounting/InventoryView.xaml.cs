using Microsoft.Win32;
using Newtonsoft.Json;
using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Media.Imaging;
using System.Xml.Linq;

namespace MatchaAccounting
{
    public partial class InventoryView : UserControl
    {
        private const string InventoryFilePath = "inventory.json";
        private ObservableCollection<InventoryItem> inventoryItems;
        private string selectedImagePath;

        public InventoryView()
        {
            InitializeComponent();
            LoadInventory();
        }

        private void LoadInventory()
        {
            inventoryItems = LoadInventoryFromJson();
            dgInventory.ItemsSource = inventoryItems;
        }

        private void btnRefresh_Click(object sender, RoutedEventArgs e)
        {
            LoadInventory();
        }

        private void btnBrowse_Click(object sender, RoutedEventArgs e)
        {
            OpenFileDialog openFileDialog = new OpenFileDialog();
            openFileDialog.Filter = "Image files (*.jpg, *.jpeg, *.png)|*.jpg;*.jpeg;*.png";
            if (openFileDialog.ShowDialog() == true)
            {
                selectedImagePath = openFileDialog.FileName;
                lblImagePath.Text = System.IO.Path.GetFileName(selectedImagePath);
            }
        }

        private void btnAdd_Click(object sender, RoutedEventArgs e)
        {
            string name = txtName.Text.Trim();
            if (!int.TryParse(txtQuantity.Text, out int quantity))
            {
                ShowMessage("Invalid quantity.", "Error");
                return;
            }

            if (string.IsNullOrEmpty(name))
            {
                ShowMessage("Name cannot be empty.", "Error");
                return;
            }

            // Check if item already exists
            if (inventoryItems.Any(item => item.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
            {
                ShowMessage($"Item '{name}' already exists in inventory.", "Duplicate Item");
                return;
            }

            InventoryItem newItem = new InventoryItem
            {
                Name = name,
                Quantity = quantity,
                ImagePath = selectedImagePath
            };

            inventoryItems.Add(newItem);
            SaveInventoryToJson();

            // Clear input fields
            txtName.Clear();
            txtQuantity.Text = "0";
            lblImagePath.Text = "";
            selectedImagePath = null;

            ShowMessage($"Item '{name}' added successfully!", "Success");
        }

        private void btnAddQuantity_Click(object sender, RoutedEventArgs e)
        {
            if (((Button)sender).DataContext is InventoryItem selectedItem)
            {
                selectedItem.Quantity++;
                SaveInventoryToJson();
                RefreshDataGrid();
            }
        }

        private void btnSubtractQuantity_Click(object sender, RoutedEventArgs e)
        {
            if (((Button)sender).DataContext is InventoryItem selectedItem)
            {
                if (selectedItem.Quantity > 0)
                {
                    selectedItem.Quantity--;
                    SaveInventoryToJson();
                    RefreshDataGrid();
                }
                else
                {
                    ShowMessage("Quantity cannot be less than 0.", "Warning");
                }
            }
        }

        private void btnEdit_Click(object sender, RoutedEventArgs e)
        {
            if (((Button)sender).DataContext is InventoryItem selectedItem)
            {
                // Simple edit dialog implementation
                var editWindow = new Window
                {
                    Title = "Edit Item",
                    Width = 300,
                    Height = 200,
                    WindowStartupLocation = WindowStartupLocation.CenterOwner,
                    Background = (System.Windows.Media.Brush)FindResource("WindowBackgroundBrush"),
                    ResizeMode = ResizeMode.NoResize
                };

                var stackPanel = new StackPanel { Margin = new Thickness(20) };

                // Name field
                var nameLabel = new Label { Content = "Name:", Foreground = System.Windows.Media.Brushes.White };
                var nameTextBox = new TextBox
                {
                    Text = selectedItem.Name,
                    Background = System.Windows.Media.Brushes.DarkGray,
                    Foreground = System.Windows.Media.Brushes.White
                };

                // Quantity field
                var quantityLabel = new Label { Content = "Quantity:", Foreground = System.Windows.Media.Brushes.White };
                var quantityTextBox = new TextBox
                {
                    Text = selectedItem.Quantity.ToString(),
                    Background = System.Windows.Media.Brushes.DarkGray,
                    Foreground = System.Windows.Media.Brushes.White
                };

                // Buttons
                var buttonPanel = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = (HorizontalAlignment)Orientation.Horizontal };
                var saveButton = new Button { Content = "Save", Background = System.Windows.Media.Brushes.Green, Foreground = System.Windows.Media.Brushes.White, Margin = new Thickness(5) };
                var cancelButton = new Button { Content = "Cancel", Background = System.Windows.Media.Brushes.Red, Foreground = System.Windows.Media.Brushes.White, Margin = new Thickness(5) };

                saveButton.Click += (s, args) =>
                {
                    if (int.TryParse(quantityTextBox.Text, out int newQuantity))
                    {
                        selectedItem.Name = nameTextBox.Text;
                        selectedItem.Quantity = newQuantity;
                        SaveInventoryToJson();
                        RefreshDataGrid();
                        editWindow.Close();
                        ShowMessage("Item updated successfully!", "Success");
                    }
                    else
                    {
                        ShowMessage("Invalid quantity.", "Error");
                    }
                };

                cancelButton.Click += (s, args) => editWindow.Close();

                buttonPanel.Children.Add(saveButton);
                buttonPanel.Children.Add(cancelButton);

                stackPanel.Children.Add(nameLabel);
                stackPanel.Children.Add(nameTextBox);
                stackPanel.Children.Add(quantityLabel);
                stackPanel.Children.Add(quantityTextBox);
                stackPanel.Children.Add(buttonPanel);

                editWindow.Content = stackPanel;
                editWindow.ShowDialog();
            }
        }

        private void btnDelete_Click(object sender, RoutedEventArgs e)
        {
            if (((Button)sender).DataContext is InventoryItem selectedItem)
            {
                var result = MessageBox.Show(
                    $"Are you sure you want to delete '{selectedItem.Name}'?",
                    "Confirm Delete",
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Warning);

                if (result == MessageBoxResult.Yes)
                {
                    inventoryItems.Remove(selectedItem);
                    SaveInventoryToJson();
                    ShowMessage($"Item '{selectedItem.Name}' deleted successfully!", "Success");
                }
            }
        }

        private void RefreshDataGrid()
        {
            var collectionView = CollectionViewSource.GetDefaultView(dgInventory.ItemsSource);
            collectionView?.Refresh();
        }

        private void ShowMessage(string message, string title)
        {
            MessageBox.Show(message, title, MessageBoxButton.OK, MessageBoxImage.Information);
        }

        private ObservableCollection<InventoryItem> LoadInventoryFromJson()
        {
            try
            {
                if (File.Exists(InventoryFilePath))
                {
                    string json = File.ReadAllText(InventoryFilePath);
                    return JsonConvert.DeserializeObject<ObservableCollection<InventoryItem>>(json) ?? new ObservableCollection<InventoryItem>();
                }
                else
                {
                    return new ObservableCollection<InventoryItem>();
                }
            }
            catch (Exception ex)
            {
                ShowMessage($"Error loading inventory: {ex.Message}", "Error");
                return new ObservableCollection<InventoryItem>();
            }
        }

        private void SaveInventoryToJson()
        {
            try
            {
                string json = JsonConvert.SerializeObject(inventoryItems, Formatting.Indented);
                File.WriteAllText(InventoryFilePath, json);
            }
            catch (Exception ex)
            {
                ShowMessage($"Error saving inventory: {ex.Message}", "Error");
            }
        }
    }

    
}